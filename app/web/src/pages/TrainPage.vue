<script setup lang="ts">
/** 训练页 —— 交互沿用旧版那一套（设计稿 §10.1），只把数据源换成新内容模型。
 * 四个判断照旧保留：
 *   目标词 <mark> 高亮 / 答案区才给英文释义 / 「我不会」在选项之前 /
 *   「这句有问题」随手标，标了不再出现。
 *
 *  队列来源：?solo=<senseId> 是错题板的单挑入口（页内不提供单挑按钮 ——
 *  知道要练哪个意思，选题就成了送分）。
 */
import { computed, nextTick, onActivated, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BackBtn from '../components/BackBtn.vue'
import { spellHint as hintOf, spellMatched } from '../spell'
import MarkedText from '../components/MarkedText.vue'
import { goBack as goBackNav } from '../nav'
import ScanPeek from '../components/ScanPeek.vue'
import DrillSheet from '../components/DrillSheet.vue'
import {
  buildQueue,
  buildScopeQueue,
  flagQuestion,
  makeQuestion,
  markMastered,
  newSessionId,
  practicePool,
  recordAnswer,
  SESSION_SIZE,
  type Question,
  type ScanItem,
  type SessionStats,
} from '../quiz'
import { toast } from '../toast'
import { db } from '../db'
import type { Sentence, Sense } from '../types'
import QuickEdit from '../components/QuickEdit.vue'
import WordPeek from '../components/WordPeek.vue'
import AiSheet from '../components/AiSheet.vue'
import { replaceSentence as aiReplaceSentence } from '../ai/actions'
import { aiReady } from '../ai/config'
import { describeAiError, type AiResult } from '../ai/types'

/** 名字要显式声明：App.vue 只 keep-alive 这一页（`include` 靠的就是名字）。
 *  不声明的话 keep-alive 静默不生效 —— 跳去核验再回来，
 *  这一轮做了一半的题全没了，而界面上没有任何提示说它丢了。 */
defineOptions({ name: 'TrainPage' })

const route = useRoute()
const router = useRouter()

/** 本轮每一张卡的完整快照。
 *
 *  为什么要存快照而不是靠 idx 重算：回看时必须看到**当时那道题原样** ——
 *  同样的选项、同样的顺序、同样选了哪个。重新 makeQuestion 会洗牌，
 *  于是「我刚才选的是这个」在回看里变成了另一个选项，看起来像记错了。
 *  这一条是「能轻松回看」的前提。 */
interface Step {
  q: Question
  picked: string
  result: 'CORRECT' | 'WRONG' | 'PENDING' | null
  masteredFlash: string
  /** 到这张为止的累计对错，用于在回看里还原当时的分数 */
  stats: SessionStats
}

const queue = ref<string[]>([])
/** 从词库的分组点进来时带的 scope（due / new / learning）——
 *  词库页那几个「练这组」按钮走的就是它。 */
const scopeQuery = computed<'due' | 'new' | 'learning' | null>(() => {
  const s = route.query.scope
  return s === 'due' || s === 'new' || s === 'learning' ? s : null
})

/** 顶栏标题：练的是哪一组，一眼看得出来 */
const headerTitle = computed(() => {
  if (solo.value) return '单挑'
  switch (scopeQuery.value) {
    case 'due':
      return '复习到期'
    case 'new':
      return '学新词'
    case 'learning':
      return '在学的'
    default:
      return '练习'
  }
})
/** 已作答的卡片，**按题号稀疏存放**（steps[i] 是第 i 题的作答）。
 *
 *  存成数组会出事：用户可以往前跳到一张还没答的题（比如跳过第 2 题去做第 3 题），
 *  这时中间就缺了一格。用数组的话 `steps.slice(0, cursor)` 会把第 2 题的槽位
 *  让给第 3 题，之后所有卡片的作答全部错位。用稀疏对象就没有这个问题 ——
 *  没答就是 undefined，天然表示「这一格还没有答案」。 */
const steps = ref<Record<number, Step>>({})
/** 光标：当前显示第几张 */
const cursor = ref(0)
/**
 * 每道题**还需要连对几次**（index → 剩余次数）。
 *
 * ★ 规则：错一次（或说不会）就要求**连续答对两次**才算过 ——
 *   `needFix[i] = 2`；答对一次减一，再错一次重置回 2。
 *   第一遍就答对的题不进这个表，不额外加练。
 * ★ 为什么是 2：错一次说明"刚才那个判断是错的"，连对两次才说明它被纠正了。
 */
const needFix = ref<Record<number, number>>({})

/** 还剩几道题没清 */
const needCount = computed(() => Object.keys(needFix.value).length)

/** 当前这一轮要依次问的题号（**一轮里每题只问一次**，答对就往下走） */
const passQueue = ref<number[]>([])
const passPos = ref(0)
/** 0 = 第一遍；>0 = 第几轮重练 */
const loopRound = ref(0)

/** 缓存已出过的题，避免来回切换时重新洗牌 */
const asked = ref<Record<number, Question>>({})

const answeredCount = computed(() => Object.keys(steps.value).length)
/** 「前沿」= 已作答的最大题号 + 1，也就是继续答要接着答的那一张 */
const frontier = computed(() => {
  const ks = Object.keys(steps.value).map(Number)
  return ks.length ? Math.max(...ks) + 1 : 0
})
/** 正在回看历史：当前这张答过，**且**它后面还有别的答过的题。
 *  注意不能写成「这张答过」或「cursor < 已答数量」——
 *  刚答完当前这张时两者都为真，页面会立刻跳进回看模式，
 *  底部按钮变成「上一题 / 回到第 N 题」，用户反而没法往前走。 */
const reviewing = computed(
  () => !!steps.value[cursor.value] && cursor.value < frontier.value - 1,
)
/** 跳到了一张还没答过的题、且它前面还有没答的 —— 是「跳题」不是「回看」 */
const jumpedAhead = computed(() => !steps.value[cursor.value] && cursor.value < frontier.value)
const isLast = computed(() => cursor.value >= queue.value.length - 1)

const q = ref<Question | null>(null)
/** phase 只管「有没有题 / 做没做完一轮」；
 *  选项的显隐看 revealed，作答状态看 submitted。
 * ★ 这三个必须分开：曾经用一个 phase 管两件事，结果点「显示选项」的瞬间
 *   submitted 就为真，正确答案在用户还没选之前就绿了 —— 那是泄题不是提示。 */
const phase = ref<'playing' | 'done' | 'spell' | 'spellDone'>('playing')
/** 选项已展开（点空白处或按空格） */
const revealed = ref(false)
/** 真的做了选择或点了「我不会」 */
const submitted = ref(false)
const picked = ref('')
const shownAt = ref(0)
const solo = ref(false)
const flagNote = ref('')
const flagBox = ref(false)
/** 解释区详情是否展开。默认折叠，这样四个选项 + 结论仍能一屏放下。 */
const expOpen = ref(false)
const masteredFlash = ref('')

/**
 * 三种练法。
 *
 *  `due`    到期 + 新卡（原来唯一的口径）
 *  `random` 全库随机，**不看到期不看掌握** —— 今天的题答完之后
 *           `buildQueue` 会返回空，于是「今天没事干」＝界面什么都给不出。
 *           随手抽一句猜个意思本来就是学习的一部分，只是过去没入口。
 *  `redo`   重刷**刚做完这一轮**的那批卡。
 */
type Mode = 'due' | 'redo' | 'scan'

const sessionId = ref('')
const stats = ref<SessionStats>({ correct: 0, wrong: 0, pending: 0, dueCorrect: 0, dueTotal: 0 })
const root = ref<HTMLElement | null>(null)
const strip = ref<HTMLElement | null>(null)

const KEYS = ['A', 'B', 'C', 'D']

/** 顶栏返回 = 系统返回键。训练不再有底栏，这里是唯一明确的退出路径。
 *  走 nav.ts 的 goBack：深链直接进这一屏时没有上一层，会兜底落回首页。
 *
 *  ★ 但在「单挑 / 扫读点进来」的那一轮里，第一次返回是**回到「怎么练」**，
 *    而不是直接退出训练：扫读列表就在那一屏上，人还想继续扫。
 *    这一层收在 backToPicker 里；它用 replace 去掉 query，历史只留一格。
 */
const goBack = (): void => goBackNav(router, '/')

/** 回到「怎么练」那一屏（含扫读列表），并清掉 query（replace，不新增历史） */
function backToPicker(): void {
  queue.value = []
  steps.value = {}
  asked.value = {}
  needFix.value = {}
  passQueue.value = []
  passPos.value = 0
  loopRound.value = 0
  cursor.value = 0
  lastRound.value = []
  q.value = null
  phase.value = 'playing'
  solo.value = false
  if (route.query.solo || route.query.sent || route.query.scope) {
    void router.replace({ path: '/train' })
  }
}

/** 解释区（对错 + 释义 + 标记）只在真正作答之后出现 */
const isRight = (opt: string): boolean => !!q.value && opt === q.value.sense.gloss

const nextDue = computed(() => {
  const d = q.value?.outcome?.intervalDays
  if (d == null) return ''
  return d < 1 ? '今天内' : d < 2 ? '明天' : `${Math.round(d)} 天后`
})

/** 结果区顶部那行字：回看时要说清这是历史，不然后面紧跟的「下一题」会让人以为答错了重来 */
const resultText = computed(() => {
  if (!submitted.value) return ''
  if (picked.value && isRight(picked.value)) return '对了'
  if (q.value?.outcome?.grade === 0) return '错了'
  return '记成「不会」'
})

/** 刚刚这一轮做过哪些卡 —— 「再来一遍」要用的就是它。
 *  ★ 不能重新按到期去组：刚答过的卡 dueAt 已经挪到明天、reps 也大于 0，
 *   `buildQueue` 会把它们全都排除掉，于是「再来一轮」等于什么也没发生。
 *   这正是「背完当天就无所事事」的第一个原因。 */
const lastRound = ref<string[]>([])

/* ── 拼写练习（背完一轮之后的可选加练）──
 *
 *  ★ 它**不写 SRS**：拼写是另一种记忆通路（产出 vs 辨认），把它的对错喂给
 *    间隔算法会污染「这个意思我到不到期」的判断。所以这一页只做本地练习 +
 *    一份自己的小结，不碰 progress、不写 reviewLog。
 *  ★ 只练这一轮出现过的意思 —— 刚背过的词，趁热拼一遍才有意义。
 */
interface SpellItem {
  id: string
  word: string
  gloss: string
  pos: string
}

const spellQueue = ref<SpellItem[]>([])
const spellIdx = ref(0)
const spellInput = ref('')
const spellState = ref<'ask' | 'right' | 'wrong'>('ask')
const spellHits = ref(0)
const spellMissed = ref<SpellItem[]>([])
/** 每个词还需要连对几次（id → 剩余次数）；错一次要连对两次 */
const spellNeed = ref<Record<string, number>>({})
const spellHint = ref(false)
/** 0 = 第一遍；>0 = 第几轮（只拼上一轮写错的） */
const spellRound = ref(0)
const spellInputEl = ref<HTMLInputElement | null>(null)

const spellCur = computed(() => spellQueue.value[spellIdx.value] ?? null)

/** 提示只给「首字母 + 长度」：再给多一点就等于把答案说出来了 */
const spellHintText = computed(() => hintOf(spellCur.value?.word ?? ''))


async function startSpell(): Promise<void> {
  const ids = lastRound.value.slice()
  const rows = await db.senses.bulkGet(ids)
  spellQueue.value = rows
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({ id: r.id, word: r.word, gloss: r.gloss, pos: r.pos }))
  if (!spellQueue.value.length) {
    toast('这一轮没有可拼的词')
    return
  }
  spellIdx.value = 0
  spellInput.value = ''
  spellState.value = 'ask'
  spellHits.value = 0
  spellMissed.value = []
  spellHint.value = false
  spellRound.value = 0
  phase.value = 'spell'
  await nextTick()
  spellInputEl.value?.focus()
}

function checkSpell(): void {
  const cur = spellCur.value
  if (!cur || spellState.value !== 'ask') return
  if (spellMatched(spellInput.value, cur.word)) {
    spellState.value = 'right'
    spellHits.value++
    // 连对计数：错过的词要连对两次才算过
    const need = spellNeed.value[cur.id]
    if (need != null) {
      const left = need - 1
      const copy = { ...spellNeed.value }
      if (left > 0) copy[cur.id] = left
      else delete copy[cur.id]
      spellNeed.value = copy
    }
    // 对了自动走下一个：拼写是「快节奏」的练习，多停一下反而打断
    window.setTimeout(() => spellNext(), 550)
  } else {
    spellState.value = 'wrong'
    spellNeed.value = { ...spellNeed.value, [cur.id]: 2 }
    spellMissed.value = [...spellMissed.value, cur]
  }
}

function spellNext(): void {
  if (spellIdx.value >= spellQueue.value.length - 1) {
    // ★ 走到头：这一遍写错的**再拼一遍**，只拼它们，直到全对
    const left = new Set(Object.keys(spellNeed.value))
    if (left.size) {
      spellQueue.value = spellQueue.value.filter((m) => left.has(m.id))
      spellMissed.value = []
      spellRound.value++
      spellIdx.value = 0
      spellInput.value = ''
      spellState.value = 'ask'
      spellHint.value = false
      void nextTick(() => spellInputEl.value?.focus())
      return
    }
    phase.value = 'spellDone'
    return
  }
  spellIdx.value++
  spellInput.value = ''
  spellState.value = 'ask'
  spellHint.value = false
  void nextTick(() => spellInputEl.value?.focus())
}

function retrySpell(): void {
  spellState.value = 'ask'
  spellInput.value = ''
  void nextTick(() => spellInputEl.value?.focus())
}

/** 可练池的 id 集合：重刷之前要确认那些卡还在（被标记/删掉的就不该再出现） */
let poolIds = new Set<string>()
void practicePool().then((pool) => {
  poolIds = new Set(pool.map((s) => s.id))
})

const mode = ref<Mode>('due')

function onScanDrill(it: ScanItem): void {
  scanItem.value = null
  // ★ 练一句是**浮层**，不是跳页（D46）：扫读列表就在下面，练完接着扫。
  //   原来这里 replace 到 /train?solo=，虽不占历史，但仍然把整屏换掉了。
  drillSense.value = it.sense.id
  drillSent.value = it.sentence.id
  drillOpen.value = true
}

/** 浮层里点词名 → 进词条页（先关浮层，别盖在上一层上面） */
function onDrillWord(w: string): void {
  drillOpen.value = false
  void router.push(`/word/${encodeURIComponent(w)}`)
}

/** 扫读模式钉过来的**具体那一句**（`?sent=<id>`）。
 *  只有第一题用它；后面回到「下一题」时它就该失效 ——
 *  否则单挑完一道之后，每换一题都还在出同一句。 */
const pinnedSentence = ref<number | undefined>()
/** 只有第一题用钉住的那句 */
let pinUsed = false

/** 单挑模式下的定位串：`solo` 决定练哪个意思，`sent` 决定出哪一句。 */
function syncPin(): void {
  const sent = route.query.sent
  pinnedSentence.value = sent == null ? undefined : Number(sent)
  pinUsed = false
}

async function start(which: Mode = mode.value): Promise<void> {
  const only = route.query.solo ? [String(route.query.solo)] : undefined
  solo.value = !!only
  mode.value = which
  sessionId.value = newSessionId()
  stats.value = { correct: 0, wrong: 0, pending: 0, dueCorrect: 0, dueTotal: 0 }
  // ★ 单挑（错题板 / 扫读点句）是「指哪打哪」：只练这一个意思，**不看到期**。
  //   走 buildQueue 的话，一个还没到期、也不是新卡的义项会被过滤掉 ——
  //   队列是空的，人看到的直接是结算屏（「这一句练完了」但什么都没练）。
  queue.value = only
    ? [...only]
    : scopeQuery.value
      ? await buildScopeQueue(scopeQuery.value, SESSION_SIZE)
      : which === 'redo'
          ? lastRound.value.filter((id) => poolIds.has(id))
          : await buildQueue(SESSION_SIZE)
  if (!queue.value.length) {
    if (which === 'redo') {
      toast('上一轮已经不在库里了')
      queue.value = []
    } else {
      // 正常到不了这里：没得练时首页那两个按钮本身就是置灰的。
      // 兜底只做一件事：把空队列如实呈现，**不自动跳去另一种练法**。
      queue.value = []
    }
  }
  steps.value = {}
  asked.value = {}
  needFix.value = {}
  passQueue.value = []
  passPos.value = 0
  loopRound.value = 0
  cursor.value = 0
  await loadQ()
}

/** 跳到第 i 张。范围随意 —— 往前能回看，往后能跳到还没答的（当作跳过）。 */
async function goTo(i: number): Promise<void> {
  if (i < 0 || i >= queue.value.length) return
  cursor.value = i
  await loadQ()
}

/** 回到前沿（继续答下去） */
async function resume(): Promise<void> {
  await goTo(Math.min(frontier.value, queue.value.length - 1))
}

/** 上一张。没有上一张时不去跳到别的会话，避免「按了没反应」的错觉 */
async function prev(): Promise<void> {
  if (cursor.value === 0) return
  playAnim('right')
  cursor.value--
  await loadQ()
}

async function loadQ(): Promise<void> {
  flagNote.value = ''
  flagBox.value = false
  masteredFlash.value = ''
  // 新题一律收起详情：上一题的展开状态不能带过来，否则新题一进来就被撑高
  expOpen.value = false

  if (cursor.value >= queue.value.length) {
    q.value = null
    phase.value = 'done'
    // 记下这一轮的卡，「再来一遍」重刷的就是它们
    lastRound.value = queue.value.slice()
    return
  }
  phase.value = 'playing'

  // 回看：还原那张卡的**作答结果**，但题目内容重新从库里取
  const step = steps.value[cursor.value]
  if (step) {
    // ★ 内容必须重建，不能拿内存里那个旧对象直接用。
    //   改完一句例句之后库里的值是新的，可界面还握着旧对象 —— 于是
    //   「明明存上了，回头一看还是错的」。往回翻旧题时同理。
    //   要缓存的是**作答结果**（选了哪个、对不对、SRS 状态），不是内容。
    const fresh = await makeQuestion(step.q.sense.id, step.q.sentence.id ?? undefined)
    if (fresh) step.q = fresh
    q.value = step.q
    picked.value = step.picked
    revealed.value = true
    submitted.value = step.result != null
    stats.value = { ...step.stats }
    masteredFlash.value = step.masteredFlash
    return
  }

  // 新题：题干每次都从库里重建（用户在别处改过内容，这里要跟上）；
  // 只有「钉住的那一句」需要沿用第一次出题时的选择。
  const cached = asked.value[cursor.value]
  let question: Question | null = await makeQuestion(
    queue.value[cursor.value],
    cached
      ? cached.sentence.id
      : pinUsed
        ? undefined
        : pinnedSentence.value,
  )
  if (!question) {
    // 刚被标记/删掉的句子：跳过这一张，别让用户看着空屏
    cursor.value++
    await loadQ()
    return
  }
  asked.value = { ...asked.value, [cursor.value]: question }
  pinUsed = true
  q.value = question
  // 单句练：顺手把这个意思的**其它例句**取出来，答完之后填进解析区 ——
  // 一屏只有一句短句时，下半屏全是空白；那些句子本来就在库里，摆出来才叫「解析」。
  if (solo.value) {
    const all = await db.sentences.where('senseId').equals(question.sense.id).toArray()
    soloOthers.value = all
      .filter((s) => s.id !== question!.sentence.id && !s.flagged && s.zh)
      .slice(0, 2)
  }
  picked.value = ''
  shownAt.value = performance.now()
  revealed.value = false
  submitted.value = false
  masteredFlash.value = ''
  // 键盘要能直接答题，所以每张新题都把焦点收回页面根节点
  root.value?.focus()
  scrollChipIntoView()
}

/** 让当前那张在进度条里可见 —— 20 张挤在一条上，跳转后不滚一下就不知道自己在哪 */
function scrollChipIntoView(): void {
  requestAnimationFrame(() => {
    const el = strip.value?.querySelector('.chip.cur')
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  })
}

/** 点空白处才出选项：先给一句句子让人读，再给选项，不然一眼扫过去没在想 */
function reveal(): void {
  if (revealed.value || submitted.value) return
  revealed.value = true
}

async function choose(opt: string): Promise<void> {
  if (submitted.value || reviewing.value) return
  picked.value = opt
  submitted.value = true
  await save(isRight(opt) ? 'CORRECT' : 'WRONG')
}

async function giveUp(): Promise<void> {
  if (submitted.value || reviewing.value) return
  submitted.value = true
  await save('PENDING')
}

async function save(result: 'CORRECT' | 'WRONG' | 'PENDING'): Promise<void> {
  const question = q.value
  if (!question) return
  const elapsed = Math.round(performance.now() - shownAt.value)
  const { outcome, justMastered } = await recordAnswer(
    question,
    sessionId.value,
    cursor.value,
    result,
    elapsed,
  )
  question.outcome = outcome
  const s = stats.value
  if (result === 'CORRECT') s.correct++
  else if (result === 'WRONG') s.wrong++
  else s.pending++
  if (question.isDue) {
    s.dueTotal++
    if (result === 'CORRECT') s.dueCorrect++
  }
  if (justMastered) masteredFlash.value = '这个词的意思，掌握了'

  // 存快照：回看时靠它还原当时那道题（选项顺序、选了哪个、当时的分数）
  const step: Step = {
    q: question,
    picked: picked.value,
    result,
    masteredFlash: masteredFlash.value,
    stats: { ...s },
  }
  steps.value = { ...steps.value, [cursor.value]: step }

  // ★ 连对计数：错/不会 → 需要连对两次；答对一次减一，清零才算过。
  const at = cursor.value
  if (result === 'CORRECT') {
    const need = needFix.value[at]
    if (need != null) {
      const left = need - 1
      const copy = { ...needFix.value }
      if (left > 0) copy[at] = left
      else delete copy[at]
      needFix.value = copy
    }
  } else {
    needFix.value = { ...needFix.value, [at]: 2 }
  }
}

/**
 * 下一题。三条路，顺序有讲究：
 *  1. 重练模式（loopRound > 0）：永远跳到「还没答对」里的**第一个**，全对了才收；
 *  2. 第一遍：顺序往后走；
 *  3. 第一遍走到头：还有答错的 → 开始重练，跳到最早那个错的；全对 → 结算。
 */
async function next(): Promise<void> {
  playAnim('left')
  // 1) 重练中：**这一轮里每题只问一次**，答对就往下走 ——
  //    还需要再答对的题，留到下一轮，不是原地反复问同一题。
  if (loopRound.value > 0) {
    passPos.value++
    if (passPos.value < passQueue.value.length) {
      await jumpTo(passQueue.value[passPos.value])
      return
    }
    // 这一轮问完了：还有没连对够的 → 开下一轮
    const rest = Object.keys(needFix.value).map(Number).sort((a, b) => a - b)
    if (!rest.length) {
      finishRound()
      return
    }
    loopRound.value++
    await startPass(rest)
    return
  }
  // 2) 第一遍：还没到最后一张
  if (cursor.value < queue.value.length - 1) {
    cursor.value++
    await loadQ()
    return
  }
  // 3) 第一遍走到头
  const pending = Object.keys(needFix.value).map(Number).sort((a, b) => a - b)
  if (pending.length) {
    loopRound.value = 1
    await startPass(pending)
    return
  }
  finishRound()
}

/** 开一轮重练：这一轮依次问 list 里的题（每题一次），答对就往下走 */
async function startPass(list: number[]): Promise<void> {
  passQueue.value = list
  passPos.value = 0
  await jumpTo(list[0])
}

/** 跳到某一张重新作答：清掉它上一次的作答快照，让它重新出题 */
async function jumpTo(i: number): Promise<void> {
  cursor.value = i
  const copy = { ...steps.value }
  delete copy[i]
  steps.value = copy
  await loadQ()
}

/** 收一轮：结算屏 */
function finishRound(): void {
  q.value = null
  phase.value = 'done'
  lastRound.value = queue.value.slice()
}

/** 「别练它」：这句话有问题而且懒得改/改不了时，
 *  至少让它别再出现在练习里（flagged 的句子会被队列排除）。
 *  这仍然只是止血 —— 真正的解是上面那个「改掉这句」。 */
async function onFlag(): Promise<void> {
  if (!q.value) return
  await flagQuestion(q.value, flagNote.value)
  flagBox.value = false
  await next()
}

// ── 当场改：发现问题的那一屏就是动手的那一屏 ──
// 不把人送去「词库 → 意思」页重新把这句话找回来。找不回来，坏内容就一直坏。
const edSentence = ref<Sentence | null>(null)
const edSense = ref<Sense | null>(null)

function editSentence(s: Sentence): void {
  pickBox.value = false
  edSentence.value = s
}

async function editSenseNow(id: string): Promise<void> {
  pickBox.value = false
  edSense.value = (await db.senses.get(id)) ?? null
}

/** 「有问题？改」：这道题上**真正属于内容**的东西全列出来 ——
 *  例句（英/中）+ 本题正确答案的释义。
 *
 *  为什么**不包括错项**：错项是同词性的别的词释义，借来凑数的 ——
 *  它们不是「这个词的某个意思」，改它们等于去改另一张卡片的内容。
 *  一道题的凑数选项不该有能力破坏别人的数据。
 *
 *  为什么列出来让人选，而不是直接改：用户看到的是一句具体的句子或一个
 *  具体的释义，让他先归类「我发现的这个问题属于哪一类」才能找到入口，
 *  这个分类步骤就等于把入口藏起来了 —— 而分类本该是我们做的事。 */
const pickBox = ref(false)
const fixSents = ref<Sentence[]>([])
const fixSenses = ref<Sense[]>([])

function openFixOptions(): void {
  const qq = q.value
  if (!qq) return
  fixSenses.value = [qq.sense]
  fixSents.value = [qq.sentence]
  pickBox.value = true
}

/** 去核验，不是去改。
 *  用户在这里犹豫的往往不是「这内容错没错」，而是「这个词到底有几个意思、
 *  我是不是记混了」—— 那需要看完整的一页，所以给跳转。
 *  回来由 keep-alive + onActivated 负责：还在原题，内容是新的。 */
function goSensePage(): void {
  const id = q.value?.sense.id
  pickBox.value = false
  if (id) void router.push(`/sense/${id}`)
}

function goWordPage(): void {
  const w = q.value?.sense.word
  pickBox.value = false
  if (w) void router.push(`/word/${encodeURIComponent(w)}`)
}

/** 改完回到原题，并且让这道题用上刚存进去的新内容 ——
 *  不刷新的话用户看不到变化，会怀疑到底存没存上。 */
async function onEdited(): Promise<void> {
  edSentence.value = null
  edSense.value = null
  await loadQ()
}

/* ── 点词查义（答完之后）──
 *
 *  ★ 时机是这条功能的**边界**，不是实现细节：
 *    这道题问的就是「这个词在这句话里是什么意思」，答之前把词义摊开，
 *    测的就成了「你能不能忍住不看」。所以 `pickable` 只绑 submitted，
 *    而且处理函数里再挡一道 —— 守卫和断言都盯着这两处。
 *
 *  ★ 点开之后停在浮层，不跳页：多半只是想扫一眼；真想细看再点进详情。
 *    跳页会把人从这一题上带走，回来还得重新找回这道题。
 */
const peekOpen = ref(false)
const peekToken = ref('')
/** 单句练时，同一个意思的其它例句（答完填进解析区，不让下半屏空着） */
const soloOthers = ref<Sentence[]>([])
/** 扫读里点中的那一行：先给「这句什么意思」的浮层 */
const scanItem = ref<ScanItem | null>(null)
/** 练一句的浮层（不跳页，见 D46） */
const drillOpen = ref(false)
const drillSense = ref('')
const drillSent = ref<number | undefined>(undefined)

function onPickToken(tok: string): void {
  if (!submitted.value) return
  peekToken.value = tok
  peekOpen.value = true
}

/* ── AI：当场换掉这句例句（D39）──
 *  ★ 为什么在这里而不是只放在意思页：发现「这句读着别扭 / 不像那个意思」
 *    的时刻，就是手里握着这道题的时刻。送去意思页 = 让人自己把这句找回来。
 *  ★ 换完要重新 loadQ()：题目内容每次从库里重建（D36 的同一条规矩），
 *    否则界面还挂着旧句子，用户会怀疑到底换没换。
 */
const aiOn = aiReady
const aiOpen = ref(false)
const aiBusy = ref(false)
const aiResult = ref<AiResult | null>(null)
const aiError = ref('')

async function aiReplaceCurrent(): Promise<void> {
  const sen = q.value?.sentence
  if (!sen?.id) return
  pickBox.value = false
  aiError.value = ''
  aiResult.value = null
  aiOpen.value = true
  aiBusy.value = true
  try {
    aiResult.value = await aiReplaceSentence(sen.id, '')
  } catch (e) {
    aiError.value = describeAiError(e)
  } finally {
    aiBusy.value = false
  }
}

/** 应用之后：这一题要用上新句子 */
async function onAiApplied(): Promise<void> {
  aiOpen.value = false
  await loadQ()
}

/** 从意思详情/词条页核验完回来：题目要跟着变新。
 *  状态在 keep-alive 里，所以回来还在原题、进度不丢；
 *  但**内容**不能沿用内存里那份 —— 用户在那边可能刚改过句子。 */
onActivated(() => {
  if (q.value) {
    void loadQ()
    return
  }
  // ★ 结算屏不能跟着组件缓存一起留在下一次进入里（坑 58）。
  //   keep-alive 缓存的是**组件状态**，而「从首页点『去训练』」在路由上
  //   仍然是 /train —— 与「刚才那一轮」同一个组件、同一个路由。
  //   不重置的话，用户再进来看到的是上一轮的「这一轮练完了 / 0 题」，
  //   而下面没有「怎么练」可选：界面上没有任何东西告诉他还能练。
  if (phase.value === 'done' && !route.query.solo) {
    phase.value = 'playing'
    solo.value = false
    queue.value = []
    }
})

async function onMastered(): Promise<void> {
  if (!q.value) return
  await markMastered(q.value.sense.id)
  await next()
}

function onKey(ev: KeyboardEvent): void {
  if (!q.value) return
  if (!revealed.value) {
    if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault()
      reveal()
    }
    return
  }
  const i = KEYS.indexOf(ev.key.toUpperCase())
  // 回看时按字母不重答：那是改答案，不是回看
  if (i >= 0 && q.value.options[i] && !reviewing.value) choose(q.value.options[i])
  else if (ev.key === 'Enter') next()
}

/* ── 左右滑动翻题 ──
 * 手机上「下一题」的标准手势就是滑，和原生 app 一致 —— 用户不该为了翻一题
 * 去够屏幕底部那个按钮。之前只有按钮，于是翻题成了「每次都要点」。
 *
 * 两条约束，否则很容易误触：
 *   · 只有**已作答**才能往前滑。没答就滑走 = 漏题，用户会以为已经做完了；
 *   · 横向位移要明显大于纵向位移。竖着滑主要是滚页面，不该被当成翻题。
 */
/**
 * 左右滑动翻题。**判定口径放宽过一次**（原来经常划不动）：
 *   1. 锁定阈值从 10px 降到 8px，并且**每次 move 都重新判**：
 *      人手的斜向手势常常先竖后横，只在第一下判会永远锁不上；
 *   2. 距离门槛 56 → 40（手机上 56px 已经是大半个拇指的行程）；
 *   3. 结束判定从「纵向不超过横向的 0.8」放宽到「横向大于纵向即可」——
 *      斜着划本来就是常态；
 *   4. 弹层开着时一律不翻题（否则在浮层里一划，底下的题就换了）；
 *   5. 没作答就往左划：给一句提示，而不是「什么都没发生」。
 */
/** 翻页动画方向（left = 下一题从右边进来） */
const animDir = ref<'' | 'left' | 'right'>('')
let animTimer = 0
function playAnim(dir: 'left' | 'right'): void {
  animDir.value = dir
  window.clearTimeout(animTimer)
  animTimer = window.setTimeout(() => (animDir.value = ''), 220)
}

const SWIPE_MIN = 40
const touch = { x: 0, y: 0, locked: false, dx: 0, dy: 0, blocked: false }

/** 有浮层/输入框开着时不做翻题手势 */
function gestureBlocked(target: EventTarget | null): boolean {
  if (pickBox.value || peekOpen.value || drillOpen.value || aiOpen.value) return true
  const el = target as HTMLElement | null
  return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName)
}

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t) return
  touch.x = t.clientX
  touch.y = t.clientY
  touch.locked = false
  touch.dx = 0
  touch.dy = 0
  touch.blocked = gestureBlocked(e.target)
}

function onTouchMove(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t) return
  touch.dx = t.clientX - touch.x
  touch.dy = t.clientY - touch.y
  const ax = Math.abs(touch.dx)
  const ay = Math.abs(touch.dy)
  // 横着走起来了就算横向手势（不要求第一下就比纵向大）
  if (!touch.locked && ax > 8 && ax > ay) touch.locked = true
}

function onTouchEnd(): void {
  if (!touch.locked || touch.blocked) return
  const { dx, dy } = touch
  touch.locked = false
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) <= Math.abs(dy)) return
  // 往左滑 = 下一题，往右滑 = 上一题
  if (dx < 0) {
    if (submitted.value || reviewing.value) void next()
    else toast('先答一下（或点「我不会」）再翻页')
  } else {
    void prev()
  }
}

const accuracy = computed(() =>
  stats.value.correct + stats.value.wrong === 0
    ? '—'
    : Math.round((stats.value.correct / (stats.value.correct + stats.value.wrong)) * 100) + '%',
)

/** 单句练完的结论：只有三种可能，别把整轮统计搬过来 */
const soloResult = computed(() => {
  // 一张都没答成：这个意思没有可用的句子（被标记 / 全删了）
  if (answeredCount.value === 0) return '这个意思暂时没有可练的句子'
  if (stats.value.correct > 0) return '对了'
  if (stats.value.wrong > 0) return '错了'
  return '记成「不会」'
})

const soloTone = computed(() =>
  answeredCount.value === 0
    ? 'sk'
    : stats.value.correct > 0
      ? 'ok'
      : stats.value.wrong > 0
        ? 'no'
        : 'sk',
)

/** 开一轮。
 *
 *  ★ 监听的是 `route.query.solo`，不是 onMounted。
 *    错题板的「单挑这个意思」进的是 `/train?solo=<id>`，而底部 tab 进的是
 *    `/train` —— 两者**同一个路由组件**，只差一个 query。原来挂在 onMounted 上，
 *    于是从单挑切回训练（或反过来）不会重新组队列：用户看到的是上一轮的
 *    题目/结算屏，tab 明明已经切了。query 一变就该重开一轮。
 */
/** 换练法 / 换 query 都要重开一轮。
 *  ★ watch 的是 `[solo, sent]` 两个值而不是只有 solo：
 *    从扫读点进来时两个 query 同时变，只盯 solo 的话 `sent` 会被漏掉，
 *    于是「点哪句猜哪句」退化成「随便出这个意思的一句」——
 *    表现是能点进去，但出的句子不是你点的那句（坑 51）。
 *
 *  ★ 但**不是**一进页面就自动开练。
 *    原来 immediate 一开跑，结果是：队列非空时用户看到的是答题界面，
 *    「随便练 / 扫读」只有「今天一道题都没有」的时候才露得出来 ——
 *    也就是说，能换练法的前提恰好是**当下没在练**，逻辑是反的。
 *    现在普通进入先给选择；只有从错题板/扫读带 `solo` 进来才直接开练
 *    （那种入口是「指哪打哪」，多问一句是多余的一层）。 */
watch(() => [route.query.solo, route.query.sent], syncPin, { immediate: true })
watch(
  () => [route.query.solo, route.query.sent, route.query.scope],
  () => {
    if (route.query.solo || route.query.scope) {
      void start('due')
      return
    }
    // ★ query 被清掉 = 用户按了返回（或我们 replace 掉了）。
    //   如果这时还在某一轮里，必须**回到「怎么练」**：
    //   否则组件状态不变，屏幕还是那道题 —— 看起来就是「返回没反应」。
    if (queue.value.length) backToPicker()
  },
  { immediate: true },
)
</script>

<template>
  <div
    ref="root"
    tabindex="0"
    class="wb-page"
    @keydown="onKey"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
  >
    <header class="wb-topbar">
      <div class="in">
        <!-- ★ 训练不再是 tab 页了（它是一个动作，不是一个地方），
             所以这里必须有一个明确的退出路径 —— 顶栏的箭头等价于系统返回键，
             和单词页/意思页用的是同一个 goBack（见 nav.ts）。
             之前底栏在的时候，这一屏没有返回箭头也能走；现在没了。 -->
        <!-- 返回箭头**始终在**：单挑也是训练的一种，必须能退出去。
             上一版把它藏起来（`v-if="!solo"`），于是扫读点进来之后
             既没有返回箭头、底栏也没有回列表 —— 人被困在一个只有一道题的屏上。
             单挑时它退到「怎么练」（扫读列表在那一屏），见 goBack。 -->
        <BackBtn @click="goBack" />
        <h1>{{ headerTitle }}</h1>
        <!-- ★ 这里原来有一个「错题板」按钮，拿掉了。
             错题板上就是「词 + 释义」—— 那是**这道题的答案本身**。
             把答案贴在出题的地方，入口再小也会被当成「先看一眼再答」：
             于是这一轮测的就不再是记忆，而是「你能不能忍住不看」。
             复习错题是对的，但要**换个语境**：它属于「词库/复习」，
             不属于「考试中」。 -->
      </div>
    </header>

    <div class="wb-wrap" :class="animDir ? 'qanim in-' + animDir : ''">
      <!-- ★ 扫读不再是一个「页面」，是训练页下面的一节。
           封装在 ScanList.vue 里（自己取句子、自己换一批、自己管空/加载态），
           但显示上和「今天练什么」在同一屏：用户滚一屏就知道自己能练什么、
           也能随手扫两句，不用在「训练 / 扫读」两个整屏之间来回切。
           点某一句才会进单题（那一屏只放一道题，答题时不该有别的干扰）。
           不显示中文：中文在点进去答题之后才出现（出题时露 = 泄题）。 -->

      <template v-if="q">
        <!-- ★ 单句练（solo）不摆进度格：一个格子、写着「1」，除了占地方没有别的用处。
             一块进度条只在「一轮多题」时有意义。 -->
        <div v-if="!solo" ref="strip" class="strip">
          <button
            v-for="(sid, i) in queue"
            :key="sid + i"
            class="chip"
            :class="{
              cur: i === cursor,
              ok: steps[i]?.result === 'CORRECT',
              no: steps[i]?.result === 'WRONG',
              skip: steps[i]?.result === 'PENDING',
              todo: !steps[i],
              loop: loopRound > 0 && (needFix[i] ?? 0) > 0,
            }"
            :title="`第 ${i + 1} 题`"
            @click="goTo(i)"
          >
            {{ i + 1 }}
          </button>
        </div>
        <!-- ★ 单句练时不报「第 1 / 1 题 · 已答 0 · 对 0 · 错 0」：
             这四组数字在一道题上全是废话（1/1 是恒等式，0/0/0 是还没开始）。
             只留一句「只练这一句」，顺便说明退出去在哪。 -->
        <p v-if="solo" class="where solo-where">
          只练这一句
          <span class="wb-sp" />
          <span class="rv">练完可以回列表继续扫</span>
        </p>
        <p v-else class="where">
          第 <b>{{ cursor + 1 }}</b> / {{ queue.length }} 题
          <span v-if="reviewing" class="rv">· 回看中</span>
          <span v-else-if="jumpedAhead && loopRound === 0" class="rv">· 跳过题</span>
          <span class="wb-sp" />
          <span v-if="loopRound > 0" class="rv">
          · 错题重练 · 还剩 {{ needCount }} 个（每题要连对 2 次）
        </span>
        <button v-if="loopRound > 0" class="loop-out" type="button" @click="finishRound">
          先不练了
        </button>
        <span v-else>已答 {{ answeredCount }} · 对 {{ stats.correct }} · 错 {{ stats.wrong }}</span>
        </p>

        <div class="qw">{{ q.sense.word }}</div>
        <div class="qtag">
          <span v-if="q.sense.pos">{{ q.sense.pos }}</span>
          <span v-if="q.ipa"> /{{ q.ipa }}/</span>
          <span v-if="q.sense.tier"> {{ q.sense.tier }}</span>
          <span v-if="q.sense.trap"> · 易错</span>
          <span v-if="!q.isDue" class="fresh"> · 新卡</span>
        </div>

        <!-- 例句本身不再单独挂「改」：下面一个「有问题？改」把例句、本题意思、
             选项里那几个意思全都列出来，想改哪个改哪个。
             一个入口、不挑时机（答题前答题后都能改）、不限制改什么 ——
             分成「改例句」「改选项」两个入口，等于让人先判断
             「我发现的这个问题属于哪一类」才找得到入口。 -->
        <div class="qsent">
          <!-- ★ 答完之后整句才可点：点任何一个词都能查它是什么意思（浮层），
               想细看再进词条/义项详情；不在库里的词可以当场加入词库。
               答之前保持不可点 —— 否则「查一下这个词」就成了答题的一部分。 -->
          <MarkedText
            :text="q.sentence.en"
            :form="q.sentence.form"
            :span-start="q.sentence.spanStart"
            :span-len="q.sentence.spanLen"
            :pickable="submitted"
            @pick="onPickToken"
          />
        </div>
        <p v-if="submitted" class="peektip">句子里任意一个词都能点开查</p>

        <!-- ★ 三态的判断式要分开：作答（submitted）压过呈现（revealed）。
             原来是 `v-if="!revealed"` / `v-else`，把**解释卡关在 v-else 里面** ——
             于是「我不会」那条路（submitted 变 true、revealed 一直 false）
             既看不到结论、也看不到「下一题」，整条路在界面上是死的，
             而答案其实已经写进 SRS 了（坑 54）。

             正确的顺序：答了就显示结果，没答才问「要不要看选项」。 -->
        <template v-if="submitted">
          <!-- 「我不会」作答时选项从没露出来，这里补一次完整回放，
               否则用户只看到结论、看不到正确答案是什么。 -->
          <div class="opts" :class="{ replay: !revealed }">
            <button
              v-for="(opt, i) in q.options"
              :key="opt + i"
              class="opt"
              :class="{
                right: isRight(opt),
                wrong: !revealed && opt === picked,
                dim: !isRight(opt),
              }"
            >
<span class="key">{{ KEYS[i] }}</span>
              <span class="tx">{{ opt }}</span>
            </button>
          </div>

          <!-- 解释区：默认只给结论 + 一个「详情」开关。
               以前是把对错 + 释义 + 英文 + 翻译 + 笔记 + 三个按钮一次性全展开，
               四个选项一出现就必然超出屏幕一屏多，用户得翻页才看得到
               「下一题」—— 在手机上等于没法用。
               现在：结论常驻（这是答题后最需要的信息），其余折叠。 -->
          <div class="exp" :class="{ open: expOpen }">
            <div
              class="st"
              :class="
                q.outcome && q.outcome.grade >= 4
                  ? 'ok'
                  : q.outcome && q.outcome.grade === 0
                    ? 'no'
                    : 'sk'
              "
            >
              {{ resultText }}
              <span v-if="q.outcome"> · 下次 {{ nextDue }}</span>
              <button class="more" @click="expOpen = !expOpen">
                {{ expOpen ? '收起' : '详情' }}
                <van-icon :name="expOpen ? 'arrow-up' : 'arrow-down'" size="11" />
              </button>
            </div>

            <template v-if="expOpen">
              <div class="ln">
                <b>{{ q.sense.word }} <template v-if="q.sense.pos">{{ q.sense.pos }}</template></b>
                {{ q.sense.gloss }}
              </div>
              <!-- 英文释义只在答题后出现：出题时露 = 泄题 -->
              <div v-if="q.sense.glossEn" class="ln en">{{ q.sense.glossEn }}</div>
              <div v-if="q.sentence.zh" class="ln">{{ q.sentence.zh }}</div>
              <div v-if="q.sense.note" class="note">{{ q.sense.note }}</div>
              <div v-if="masteredFlash" class="mastered">{{ masteredFlash }}</div>

              <!-- 「别练它 / 已掌握」留在详情里：这两个是**答完之后**对结果的处理，
                   不是「读到一半发现内容坏了」的补救。
                   那件事归上面的「改」—— 常驻、贴着句子、不用翻任何东西。 -->
              <div v-if="!reviewing" class="markrow">
                <van-button size="small" plain @click="onMastered">已掌握</van-button>
                <van-button size="small" plain @click="onFlag">别练它</van-button>
              </div>
            </template>
          </div>
        </template>

        <!-- 没答、也没显示选项：先问「要不要看选项」 -->
        <template v-else-if="!revealed">
          <p class="qhint">想清楚这个词在这里的意思</p>
          <div class="blank" @click="reveal">— 点击空白处显示选项 —</div>
        </template>

        <!-- 没答、选项已露：等着点选项 -->
        <template v-else>
          <div class="opts">
            <!-- ★ right / wrong / dim 只在 submitted 之后才允许加。
                 isRight(opt) 说的是「这个选项是不是正解」，它任何时候都为真；
                 早一步绑定就等于把答案用绿色标出来 —— 那是泄题，不是提示。 -->
            <button
              v-for="(opt, i) in q.options"
              :key="opt + i"
              class="opt"
              :class="{
                right: submitted && isRight(opt),
                wrong: submitted && opt === picked && !isRight(opt),
                dim: submitted && !isRight(opt) && opt !== picked,
              }"
              @click="choose(opt)"
            >
              <span class="key">{{ KEYS[i] }}</span>
              <span class="tx">{{ opt }}</span>
            </button>
          </div>
        </template>

        <!-- ★ 单句练答完之后：这一屏本来只有「不长的题干 + 一行对错」，
             下半屏全是空白 —— 看着像「这一页没做完」。
             填进去的人都有的东西：**这句的中文**、**正解**、**这个意思的其它例句**。
             这些不是拿空白去凑，它们本来就是「这一句」的解析。 -->
        <section v-if="solo && submitted && q" class="solo-x">
          <p class="x-h">这一句</p>
          <p v-if="q.sentence.zh" class="x-zh">{{ q.sentence.zh }}</p>
          <div class="x-gloss">
            <span class="x-pos">{{ q.sense.pos || '—' }}</span>
            <span class="x-g">{{ q.sense.gloss }}</span>
          </div>
          <template v-if="soloOthers.length">
            <p class="x-h2">同一个意思的其它例句</p>
            <div v-for="o in soloOthers" :key="o.id" class="x-o">
              <p class="x-en">{{ o.en }}</p>
              <p v-if="o.zh" class="x-zh2">{{ o.zh }}</p>
            </div>
          </template>
          <p v-else class="x-h2">这个意思只有这一句。</p>
        </section>

        <!-- 「有问题？改」：一个入口，什么都能改，什么时候都能改。
             它挂在「有没有题」这一层，而不是任何一个答题分支里 ——
             内容坏了的那一刻就该能动手；等答完题才给入口，
             等于要求先被坏内容考一次，才轮到你修它。
             而且只给一个入口：分成「改例句 / 改选项」两个，等于让人先
             归类问题属于哪一类才找得到；分类这件事本该由我们做。 -->
        <button class="fixrow" type="button" @click="openFixOptions">有问题？改</button>
      </template>

      <!-- 开场与结算 -->
      <template v-else>
        <!-- ★ 结算屏占满整屏。
             原来是一张 .wb-card 小卡片浮在顶部，下面空一大片：手机上一屏放得下，
             内容却只用了顶部四分之一，视觉上「练完了」这件事被缩成了角落里
             几行小字。现在竖向居中、主数字放到 64px、对/错/不会三块并排，
             两个按钮都在拇指区。 -->
        <section v-if="phase === 'done'" class="done">
          <!-- 单句练（扫读点进来 / 错题板单挑）：**不要**端出整轮的统计。
               一道题的正确率、三块色块、到期题数 —— 全是为一轮二十题准备的，
               放在这里只会让人觉得「我做了什么大事」。 -->
          <template v-if="solo">
            <p class="done-k">这一句练完了</p>
            <p class="solo-res" :class="soloTone">{{ soloResult }}</p>
            <p class="done-note">要继续扫就回列表；这个词的进度已经记下了。</p>
            <div class="done-btns">
              <van-button type="primary" block round @click="backToPicker">回到扫读</van-button>
              <van-button block round @click="start('redo')">再来一遍</van-button>
            </div>
          </template>

          <template v-else>
            <div>
              <p class="done-k">这一轮练完了</p>
              <p class="done-big">{{ answeredCount }}<span>题</span></p>
            </div>
            <div class="tiles">
              <div class="t ok"><b>{{ stats.correct }}</b><span>对</span></div>
              <div class="t no"><b>{{ stats.wrong }}</b><span>错</span></div>
              <div class="t sk"><b>{{ stats.pending }}</b><span>不会</span></div>
            </div>
            <p class="done-note">
              到期题正确率 {{ stats.dueTotal ? accuracy : '—' }} · 共 {{ stats.dueTotal }} 题到期
            </p>
            <!-- ★ 拼写是**可选加练**：认得出 ≠ 写得出。
                 只在「一轮」结束之后提供（单句练没有这个意义）。 -->
            <div v-if="lastRound.length" class="spell-offer">
              <p class="so-h">要不要再拼一遍？</p>
              <p class="so-s">看中文，把英文写出来。不计入间隔重复，只练手。</p>
              <van-button type="primary" block round @click="startSpell">
                拼写这 {{ lastRound.length }} 个
              </van-button>
            </div>

            <div class="done-btns">
              <!-- ★ 这里原来是 @click="start"，也就是**按到期重新组一轮**。
                   刚答过的卡 dueAt 挪到了明天、reps 也大于 0，于是 buildQueue
                   把它们全部排除 —— 点了「再来一轮」结果队列是空的，
                   表现就是「按了没反应 / 什么都不变」。
                   「再刷一遍」要的是**重刷刚做完的那批**，所以用 redo。 -->
              <van-button type="primary" block round @click="start('redo')">再来一遍</van-button>

              <!-- 用路由名，不写路径：首页的路径是 '/'，写成 '/home' 会匹配不到
                   任何路由 —— 表现是点了之后一片空白（既不是首页也不是报错），
                   而 /home 这种「看起来应该存在」的错字编译器不会拦。 -->
              <van-button block round @click="router.push({ name: 'home' })">回首页</van-button>
            </div>
          </template>
        </section>

        <!-- 拼写练习 -->
        <section v-else-if="phase === 'spell'" class="spell">
          <header class="sp-h">
            <span class="sp-title">拼写</span>
            <span class="sp-n">
              <template v-if="spellRound > 0">第 {{ spellRound + 1 }} 轮 · </template>
              {{ spellIdx + 1 }} / {{ spellQueue.length }}
            </span>
            <span class="wb-sp" />
            <button class="sp-x" type="button" @click="phase = 'done'">结束</button>
          </header>

          <div class="sp-card">
            <p v-if="spellCur?.pos" class="sp-pos">{{ spellCur.pos }}</p>
            <p class="sp-gloss">{{ spellCur?.gloss }}</p>
            <p v-if="spellHint" class="sp-hint">{{ spellHintText }}</p>
          </div>

          <input
            ref="spellInputEl"
            v-model="spellInput"
            class="sp-input"
            :class="{ ok: spellState === 'right', no: spellState === 'wrong' }"
            type="text"
            inputmode="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="写出英文"
            :disabled="spellState !== 'ask'"
            @keyup.enter="spellState === 'ask' ? checkSpell() : spellNext()"
          />

          <p v-if="spellState === 'right'" class="sp-ok">对了</p>
          <p v-else-if="spellState === 'wrong'" class="sp-no">
            正确答案：<b>{{ spellCur?.word }}</b>
          </p>

          <div class="sp-acts">
            <template v-if="spellState === 'ask'">
              <button class="sp-b" type="button" @click="spellHint = true">提示</button>
              <button class="sp-b primary" type="button" @click="checkSpell">对一下</button>
            </template>
            <template v-else>
              <button v-if="spellState === 'wrong'" class="sp-b" type="button" @click="retrySpell">
                再试一次
              </button>
              <button class="sp-b primary" type="button" @click="spellNext">下一个</button>
            </template>
          </div>
        </section>

        <!-- 拼写结算 -->
        <section v-else-if="phase === 'spellDone'" class="spell-done">
          <p class="done-k">拼写完成</p>
          <p class="done-big">{{ spellHits }}<span>/ {{ spellQueue.length }}</span></p>
          <div v-if="spellMissed.length" class="miss">
            <p class="miss-h">写错的 {{ spellMissed.length }} 个</p>
            <p v-for="m in spellMissed" :key="m.id" class="miss-i">
              <b>{{ m.word }}</b> · {{ m.gloss }}
            </p>
          </div>
          <div class="done-btns">
            <van-button type="primary" block round @click="startSpell">再拼一遍</van-button>
            <van-button block round @click="phase = 'done'">回到结算</van-button>
            <van-button block round @click="router.push({ name: 'home' })">回首页</van-button>
          </div>
        </section>

        <!-- ★ 这里原来是「怎么练」选择器 + 扫读列表。
             两样都被首页接走了：屏一 = 随机刷，屏二 = 句子列表。
             于是这一页只负责「按计划/单挑的那一轮」，没有再让人选一次练法的道理。 -->
        <template v-else>
          <p class="wb-dim empty-tip">
            这一组没有可练的了。回首页刷两句，或者去词库看看。
          </p>
          <van-button block round @click="router.push('/')">回首页</van-button>
        </template>
      </template>
    </div>

    <!-- 改东西：先选「是哪一处不对」，再改它 -->
    <van-popup :show="pickBox" position="bottom" round close-on-popstate @close="pickBox = false">
      <div class="pick">
        <h3>哪里不对？</h3>
        <button
          v-for="s in fixSents"
          :key="'s' + s.id"
          class="pickrow"
          type="button"
          @click="editSentence(s)"
        >
          <span class="gl">例句：{{ s.en }}</span>
          <span class="go">改</span>
        </button>
        <button
          v-for="s in fixSenses"
          :key="'m' + s.id"
          class="pickrow"
          type="button"
          @click="editSenseNow(s.id)"
        >
          <span class="gl">意思：{{ s.gloss }}</span>
          <span class="go">改</span>
        </button>
        <p v-if="!fixSenses.length && !fixSents.length" class="wb-dim">这道题没有可改的内容。</p>

        <!-- 「改」和「去看看」是两件事，各走各的：
             改 = 我确定它错了，趁现在改掉；
             核 = 我不确定，想看看这个词还有什么别的意思/例句。
             核验需要的是**更多上下文**，那在详情页，所以给一个跳转；
             而跳转必须能原样回来（keep-alive 留着这一页 + onActivated 刷新内容），
             否则没人敢跳 —— 跳一次丢一轮，谁还愿意核验。 -->
        <!-- ★ AI 换一句放在**这里**，不是放在意思页（D39）：
             发现「这句读着别扭」的那一刻就是现在、就是这一屏。
             原来要退出训练 → 词库 → 这个词 → 这个意思 → 找到那一句 → 点 AI 换一句，
             六步之后你已经不想换了。 -->
        <button
          v-if="aiOn && q"
          class="pickrow nav airow"
          type="button"
          @click="aiReplaceCurrent"
        >
          <span class="gl">让 AI 换掉这句例句</span>
          <span class="go">AI</span>
        </button>

        <div class="psep" />
        <button class="pickrow nav" type="button" @click="goSensePage">
          <span class="gl">看看这个意思的详情</span>
          <span class="go">›</span>
        </button>
        <button class="pickrow nav" type="button" @click="goWordPage">
          <span class="gl">看看这个词</span>
          <span class="go">›</span>
        </button>
      </div>
    </van-popup>

    <!-- 当场改：浮层挂在页面最外层，任何时刻都能打开 -->
    <QuickEdit
      :sentence="edSentence"
      :sense="edSense"
      @saved="onEdited"
    />

    <!-- 点词查义：答完之后才可能被打开（见 onPickToken 的守卫） -->
    <WordPeek :show="peekOpen" :token="peekToken" @close="peekOpen = false" />

    <!-- 扫读点中一行：先给「这句什么意思」，再问要不要练 -->
    <ScanPeek
      :item="scanItem"
      :total="scanItem?.count ?? 0"
      @close="scanItem = null"
      @drill="onScanDrill"
    />

    <!-- 练这一句：浮层，不跳页（D46） -->
    <DrillSheet
      :open="drillOpen"
      :sense-id="drillSense"
      :sentence-id="drillSent"
      @close="drillOpen = false"
      @word="onDrillWord"
    />

    <!-- AI 提议（换一句）：和词条页/意思页共用同一张浮层 -->
    <AiSheet
      :show="aiOpen"
      :result="aiResult"
      :busy="aiBusy"
      :error="aiError"
      @close="aiOpen = false"
      @applied="onAiApplied"
    />

    <!-- ★ 固定在底部的主操作条。
         之前的「再来一个」按钮在解释卡里，只有答完题才出现，而且位置在
         页面最下面 —— 手机上答完题要往下滑一屏才找得到，于是「背单词不方便」
         的第一症结就是这个按钮根本不在拇指够得到的地方。
         固定条把主行动放在同一个位置、拇指区，不管题多长都在那。 -->
    <div v-if="q" class="abar">
      <!-- ★ 分支的判断顺序与判断式都很要紧（坑 54）。
           这里问的必须是「这一题**答了**没有」（submitted），
           不能用「选项**露出来**没有」（revealed）去代替：
           revealed 是**呈现**状态，submitted 是**作答**状态，两者不等价。
           「我不会」这条路 submitted 变 true 而 revealed 一直是 false，
           于是 `v-else-if="!revealed"` 永远命中 —— 主行动永远停在
           「我不会」上，「下一题」那个分支根本到不了。
           表现是：点了毫无反应（答案其实记进 SRS 了），再点也没用，
           用户被卡在这一题上出不去。

           所以顺序是：先问作答状态，再问回看，最后才轮到呈现状态。 -->
      <!-- 回看中（且还没作答）：左边是回到当前位置，右边继续往后翻 -->
      <template v-if="reviewing && !submitted">
        <van-button size="small" plain :disabled="cursor === 0" @click="prev">上一题</van-button>
        <van-button size="small" type="primary" @click="resume">
          继续（第 {{ frontier + 1 }} 题）
        </van-button>
      </template>
      <!-- 还没出选项：主动作是「显示选项」，副动作是「我不会」 -->
      <template v-else-if="!submitted && !revealed">
        <van-button size="small" plain @click="giveUp">我不会</van-button>
        <van-button class="wide" type="primary" @click="reveal">显示选项</van-button>
      </template>
      <!-- 已出选项但还没选：等着点选项，这里只放后退 -->
      <template v-else-if="!submitted">
        <van-button size="small" plain :disabled="cursor === 0" @click="prev">上一题</van-button>
        <span class="apick">点上面四个选项作答</span>
      </template>
      <!-- 答完了（无论走的哪条作答路径）：主行动前进，左边给回看 -->
      <template v-else-if="solo">
        <!-- 单句练没有「下一题」：答完就是答完，直接回列表继续扫。
             原来这里还是「下一题 / 看看本轮结果」，而队列只有一张卡 ——
             点了要么回到同一张，要么进那个一道题的结算屏，都是多余的一步。 -->
        <van-button class="wide" type="primary" @click="backToPicker">回到扫读</van-button>
      </template>
      <template v-else>
        <van-button size="small" plain :disabled="cursor === 0" @click="prev">上一题</van-button>
        <van-button class="wide" type="primary" @click="next">
          {{ isLast ? '看看本轮结果' : '下一题' }}
        </van-button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ── 进度格 ──
   20 张题挤在一条横线上，所以做成可横向滚动 + 跳转变后自动把当前那张滚到中间。
   色块含义直接写进 title：绿=对 红=错 黄=不会 灰=还没答。 */
.strip {
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding: 12px 0 2px;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.strip::-webkit-scrollbar {
  display: none;
}

.chip {
  flex: 0 0 auto;
  min-width: 26px;
  height: 26px;
  padding: 0 5px;
  border-radius: 8px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  color: var(--wb-ink-3);
  font-size: 12px;
  font-family: inherit;
  /* 触摸目标 26px 太小，手指粗的人会点空 —— 视觉 26px，热区用
     padding 撑到 40px 高（上下各多 7px） */
  padding-top: 7px;
  padding-bottom: 7px;
  box-sizing: content-box;
  cursor: pointer;
}

.chip.todo {
  color: var(--wb-ink-3);
}

.chip.ok {
  background: #eafaf1;
  border-color: var(--van-success-color);
  color: #0a7a45;
}

.chip.no {
  background: #fdeced;
  border-color: var(--van-danger-color);
  color: #c1291f;
}

.chip.skip {
  background: #fff7e8;
  border-color: var(--van-warning-color);
  color: #8a5a12;
}

/* 当前题：加粗 + 一圈描边，一眼能定位 */
/* 左右翻页：新题从手指方向的另一侧滑进来（180ms，短到不打断节奏） */
.qanim.in-left {
  animation: slideFromRight 0.18s ease;
}

.qanim.in-right {
  animation: slideFromLeft 0.18s ease;
}

@keyframes slideFromRight {
  from {
    transform: translateX(26px);
    opacity: 0.35;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

@keyframes slideFromLeft {
  from {
    transform: translateX(-26px);
    opacity: 0.35;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

.loop-out {
  margin-left: auto;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  color: var(--wb-ink-3);
  text-decoration: underline;
  padding: 0 2px;
  cursor: pointer;
}

.chip.loop {
  border-color: #d99a2b;
  box-shadow: inset 0 0 0 1px #d99a2b;
}

.chip.cur {
  border-color: var(--wb-primary);
  border-width: 2px;
  color: var(--wb-primary);
  font-weight: 700;
  background: #fff;
}

.where {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 7px 0 4px;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.where b {
  color: var(--wb-ink);
}

.where .rv {
  color: var(--wb-primary);
  font-weight: 600;
}

/* ── 底部固定操作条 ──
   位置：贴着底部安全区上方。tabbar 是 fixed 在最底的，所以这条要抬高一格，
   不能 bottom:0 —— 那样会被 tabbar 盖住一半，「显示选项」会点不到。 */
.abar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--wb-tabbar-h) + var(--wb-safe-bottom));
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  background: color-mix(in srgb, var(--wb-bg) 92%, transparent);
  backdrop-filter: blur(10px);
  border-top: 1px solid var(--wb-line);
}

/* 主行动：吃掉剩余宽度。手机上的主按钮不该和副按钮差不多大，
   否则两个都像次要操作，用户每次都要犹豫该点哪个。 */
.abar .wide {
  flex: 1;
  height: 42px;
  font-size: 15.5px;
  font-weight: 600;
}

.apick {
  flex: 1;
  text-align: center;
  font-size: 13px;
  color: var(--wb-ink-3);
}

.qw {
  /* 32px → 26px：单词是「扫一眼」的内容，不是标题。
     一屏里要塞下：进度格 + 进度 + 单词 + 音标 + 词性 + 例句 + 四个选项 +
     对错结论 + 固定操作条。原尺寸下光是单词就吃掉 40px，选项必然溢出。 */
  font-size: 26px;
  font-weight: 700;
  text-align: center;
  letter-spacing: -0.5px;
  line-height: 1.2;
}

.qtag {
  text-align: center;
  font-size: 12px;
  color: var(--wb-ink-3);
  margin-top: 2px;
  margin-bottom: 12px;
}

.qtag .fresh {
  color: var(--wb-primary);
}

.qsent {
  position: relative;
  text-align: center;
  font-size: 17px;
  line-height: 1.6;
  margin: 8px 0 14px;
}

/* 贴着例句右上角的一个小「改」。它安静到不像一个功能 ——
   平时没人会点它，但真有坏句子时它就在那儿，不用翻详情、不用换页。 */
.fixline {
  position: absolute;
  top: -2px;
  right: 0;
  border: 1px dashed var(--wb-line);
  background: transparent;
  border-radius: 6px;
  padding: 1px 6px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--wb-ink-3);
  font-family: inherit;
  cursor: pointer;
}

.fixline:active {
  background: var(--wb-bg);
  color: var(--wb-ink-2);
}

.qhint {
  text-align: center;
  font-size: 12.5px;
  color: var(--wb-ink-2);
  margin-bottom: 8px;
}

/* 答完之后的小提示：告诉用户「现在能点词了」。
   点词这件事**没有视觉入口**（句子就是句子），不说一句就没人会去点。 */
.peektip {
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-ink-3);
  margin: -8px 0 10px;
}

.blank {
  background: var(--wb-card);
  border: 1.5px dashed var(--wb-line);
  border-radius: var(--wb-radius);
  padding: 14px;
  text-align: center;
  color: var(--wb-ink-3);
  font-size: 13px;
  cursor: pointer;
}

/* ★ 两个选项一行（2×2）。
 * 一行一个的话四个选项就是 4×50 = 200px，加上单词/例句/结论，
 * 一屏放不下 —— 用户得翻页才能看到「下一题」。
 * 两列把这一块压到 2×44 = 88px，省下的 112px 正好够结论和操作条。
 * 宽度上 2 列每列约 165px，中文释义（多为 2~6 字）放得下。 */
.opts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

/* 「我不会」作答后的选项回放：不可点，但要读得出哪个是正解。
   没有这个 class 时它长得和正常选项一模一样，用户会以为还能点。 */
.opts.replay .opt {
  cursor: default;
  pointer-events: none;
}

.opt {
  display: flex;
  gap: 7px;
  align-items: center;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: var(--wb-radius);
  padding: 10px;
  text-align: left;
  font-family: inherit;
  font-size: 14px;
  color: var(--wb-ink);
  cursor: pointer;
  width: 100%;
  min-height: 44px;
}

.opt .tx {
  /* 释义再长也要留在本行内：选项一旦换行，四行变五行，布局又挤出去了 */
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 1.35;
}

.blank:active {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}

.giveup {
  text-align: center;
  margin: 14px 0 0;
}

.giveup a {
  color: var(--wb-ink-3);
  font-size: 13px;
  border-bottom: 1px dashed var(--wb-line);
  padding: 5px 10px;
  cursor: pointer;
}

/* 训练页底部有一条固定操作条，页面留白要多让出它的高度，
   否则最后一张题的选项会被压在条子底下点不到 */
.wb-page :deep(.wb-wrap) {
  padding-bottom: 64px;
}

.opt:active {
  border-color: var(--wb-primary);
}

.opt .key {
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, monospace;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--wb-bg);
  color: var(--wb-ink-2);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.opt.right {
  border-color: var(--van-success-color);
  background: #eafaf1;
}

.opt.right .key {
  background: var(--van-success-color);
  color: #fff;
}

.opt.wrong {
  border-color: var(--van-danger-color);
  background: #fdeced;
}

.opt.wrong .key {
  background: var(--van-danger-color);
  color: #fff;
}

/* 没选中的其它项：答完后压暗，让对错一眼分明 */
.opt.dim {
  opacity: 0.55;
}

.exp {
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 10px 12px;
  margin-top: 10px;
}

.exp .st {
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 展开/收起开关：答题后用户最常问的是「为什么是这个意思」，
   所以把它做成一个一直看得见的按钮，而不是藏在解释里。 */
.more {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 0;
  background: var(--wb-bg);
  color: var(--wb-ink-3);
  font-family: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.exp .st.ok {
  color: var(--van-success-color);
}

.exp .st.no {
  color: var(--van-danger-color);
}

.exp .st.sk {
  color: var(--van-warning-color);
}

.exp .ln {
  font-size: 13.5px;
  margin: 6px 0;
  line-height: 1.6;
}

.exp .ln.en {
  color: var(--wb-ink-2);
  font-size: 12.5px;
}

.exp .note {
  font-size: 12.5px;
  color: #8a5a12;
  background: #fff7e8;
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 9px;
  line-height: 1.6;
}

.mastered {
  font-size: 13px;
  color: var(--van-success-color);
  margin-top: 8px;
  font-weight: 600;
}

/* 答案区下面那两个「标记类」按钮。★ 原来叫 .line，和扫读的行同名 ——
   同一个 <style scoped> 里两条同名规则会**合并**，于是扫读的行
   莫名继承了这里的 flex-wrap: wrap：句子被挤到第二行，行号孤零零留在上面
   （真机量到偏差正好 = 行高 22.5 + gap 9 = 31.5px，一行都不差）。
   教训：同名就是同一个东西，想表达「两处长得像」也得起不同的名字。 */
.markrow {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--wb-line);
  flex-wrap: wrap;
}

/* 单句练的解析区：把「这一句」讲完 —— 中文、正解、这个意思的其它例句。
   它存在的理由就是补上那半屏空白，所以每一块都必须是**内容**，不是装饰。 */
.solo-x {
  margin-top: 14px;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  padding: 12px 14px 6px;
}

.x-h {
  font-size: 12px;
  color: var(--wb-ink-3);
  margin-bottom: 4px;
}

.x-zh {
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.x-gloss {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--wb-line);
}

.x-pos {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.x-g {
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-ink);
}

.x-h2 {
  margin: 14px 0 6px;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.x-o {
  padding: 8px 0;
  border-top: 1px dashed var(--wb-line);
}

.x-en {
  font-size: 14px;
  line-height: 1.6;
  color: var(--wb-ink);
}

.x-zh2 {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}

/* 「选项不对？改」：一个入口，放在选项下面。
   不放进选项里 —— 四个选项各挂一个「改」，用户得先在心里挑出
   「是哪一条不对」才找得到它，判断成本原封不动地推回给了用户。 */
.fixrow {
  display: block;
  width: 100%;
  margin-top: 10px;
  padding: 8px;
  border: 1px dashed var(--wb-line);
  background: transparent;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.fixrow:active {
  background: var(--wb-bg);
  color: var(--wb-ink-2);
}

.pick {
  padding: 18px 16px calc(14px + env(safe-area-inset-bottom, 0px));
}

.pick h3 {
  font-size: 16.5px;
  font-weight: 600;
  margin-bottom: 12px;
}

.pickrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 12px 4px;
  border: 0;
  border-bottom: 1px solid var(--wb-line);
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  text-align: left;
  color: var(--wb-ink);
  cursor: pointer;
}

.pickrow .gl {
  flex: 1 1 auto;
  min-width: 0;
}

.pickrow .go {
  flex: 0 0 auto;
  font-size: 13px;
  color: var(--wb-ink-3);
  border: 1px solid var(--wb-line);
  border-radius: 999px;
  padding: 3px 10px;
}

/* 「改」和「看看」之间那条线：上面是改内容，下面是去看别的页面。
   两件事混在一列里不加区分，用户会以为「看看」也是改的入口。 */
.psep {
  height: 1px;
  background: var(--wb-line);
  margin: 12px 0 2px;
}

.pickrow.nav .gl {
  color: var(--wb-ink-2);
}

.pickrow.nav .go {
  border: 0;
  font-size: 17px;
  padding: 0 4px;
}

.flagbox {
  display: flex;
  gap: 7px;
  align-items: center;
  margin-top: 10px;
}

.flagbox :deep(.van-field) {
  flex: 1;
  background: var(--wb-bg);
  border-radius: 8px;
  padding: 7px 10px;
}

/* ── 拼写练习（可选加练） ── */
.spell-offer {
  margin: 14px 0 4px;
  padding: 14px;
  border: 1px dashed var(--wb-line);
  border-radius: 14px;
  background: var(--wb-card);
}

.so-h {
  font-size: 15px;
  font-weight: 650;
  color: var(--wb-ink);
}

.so-s {
  margin: 5px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}

.spell {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px 0 4px;
}

.sp-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 10px;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.sp-title {
  color: var(--wb-ink);
  font-weight: 650;
}

.sp-n {
  font-variant-numeric: tabular-nums;
}

.sp-x {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.sp-card {
  flex: 0 0 auto;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  padding: 18px 16px;
}

.sp-pos {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.sp-gloss {
  margin-top: 4px;
  font-size: 20px;
  line-height: 1.5;
  font-weight: 600;
  color: var(--wb-ink);
}

.sp-hint {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--wb-primary);
}

.sp-input {
  flex: 0 0 auto;
  margin-top: 16px;
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  border: 1.5px solid var(--wb-line);
  border-radius: 14px;
  background: var(--wb-card);
  font-family: inherit;
  font-size: 20px;
  letter-spacing: 0.5px;
  color: var(--wb-ink);
  outline: none;
}

.sp-input:focus {
  border-color: var(--wb-primary);
}

.sp-input.ok {
  border-color: #12a05c;
  background: #f0fbf5;
  color: #0a7a45;
}

.sp-input.no {
  border-color: #d24b3e;
  background: #fdf1f0;
  color: #c1291f;
}

.sp-ok {
  margin-top: 10px;
  font-size: 14px;
  font-weight: 650;
  color: #12a05c;
}

.sp-no {
  margin-top: 10px;
  font-size: 14px;
  color: #c1291f;
}

.sp-no b {
  font-size: 17px;
}

.sp-acts {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  margin-top: auto;
  padding-top: 16px;
}

.sp-b {
  flex: 1;
  padding: 13px 10px;
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  background: var(--wb-card);
  font-family: inherit;
  font-size: 15px;
  color: var(--wb-ink);
  cursor: pointer;
}

.sp-b.primary {
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  color: #fff;
  font-weight: 600;
}

.spell-done {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
}

.miss {
  margin-top: 16px;
  text-align: left;
  max-height: 34vh;
  overflow-y: auto;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  padding: 10px 14px;
}

.miss-h {
  font-size: 11.5px;
  color: var(--wb-ink-3);
  padding-bottom: 6px;
}

.miss-i {
  padding: 6px 0;
  border-top: 1px dashed var(--wb-line);
  font-size: 13.5px;
  color: var(--wb-ink-2);
}

.miss-i b {
  color: var(--wb-ink);
  font-size: 15px;
}

/* ── 结算屏 ──
   竖向居中 + 内容撑满一屏。min-height 里减掉状态栏、tabbar 和一点呼吸，
   否则最后两个按钮会被固定 tabbar 压住。 */
.done {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 20px;
  text-align: center;
  min-height: calc(100dvh - var(--wb-sb-h) - var(--wb-tabbar-h) - var(--wb-safe-bottom) - 32px);
  padding: 12px 4px 20px;
}

.done-k {
  margin: 0;
  font-size: 14.5px;
  color: var(--wb-ink-3);
}

/* 单句练的结论：一个词就够，别再摆三块色块 */
.solo-res {
  margin: 10px 0 6px;
  font-size: 26px;
  font-weight: 750;
  letter-spacing: -0.5px;
}

.solo-res.ok {
  color: #12a05c;
}

.solo-res.no {
  color: #c1291f;
}

.solo-res.sk {
  color: #b26a00;
}

.done-big {
  margin: 4px 0 0;
  font-size: 60px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -2px;
  color: var(--wb-primary);
}

.done-big span {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0;
  margin-left: 5px;
  color: var(--wb-ink-3);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.tiles .t {
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 15px 6px 13px;
}

.tiles b {
  display: block;
  font-size: 27px;
  font-weight: 700;
  line-height: 1.2;
}

.tiles span {
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.t.ok b {
  color: var(--van-success-color);
}

.t.no b {
  color: var(--van-danger-color);
}

.t.sk b {
  color: var(--van-warning-color);
}

.done-note {
  margin: 0;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.done-btns {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 主按钮够大、够高：手机上「再来一轮」是这一屏唯一的主动作 */
.done-btns :deep(.van-button) {
  height: 50px;
  font-size: 16.5px;
  font-weight: 600;
}

</style>
