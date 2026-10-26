<script setup lang="ts">
/** 一轮训练会话 —— 背单词的**本体**，两个壳共用同一套判分链路：
 *   · /train 路由（TrainPage 薄壳：顶栏 + 返回，从词库「练这组」进来）
 *   · 首页的「复习 / 学习」tab（embedded：没有顶栏，左右滑是外层 tab 翻页）
 *
 *  四个判断照旧保留（设计稿 §10.1）：
 *    目标词 <mark> 高亮 / 答案区才给英文释义 / 「我不会」在选项前或选项下 /
 *    「这句有问题」随手标，标了不再出现。
 *
 *  队列来源只看 props.scope（due / new / learning）。
 *  单挑（?solo=）与扫读点句（?sent=）已退场：错题板不设答题入口（D51）；
 *  独立扫读 tab 也已退场 —— 扫读卡混进随便刷队列（quiz.ts buildRandomQueue）。
 */
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { spellHint as hintOf, spellMatched } from '../spell'
import MarkedText from './MarkedText.vue'
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
  type SessionStats,
} from '../quiz'
import { toast } from '../toast'
import { autoSpeak, speakEn, speechOn, ttsWaiting } from '../speech'
import { allProgress, db } from '../db'
import { forecastDaily, forecastSummary, type ForecastResult } from '../forecast'
import ForecastBars from './ForecastBars.vue'
import type { Sentence, Sense } from '../types'
import QuickEdit from './QuickEdit.vue'
import WordPeek from './WordPeek.vue'
import AiSheet from './AiSheet.vue'
import { replaceSentence as aiReplaceSentence } from '../ai/actions'
import { aiReady } from '../ai/config'
import { describeAiError, type AiResult } from '../ai/types'

const props = withDefaults(
  defineProps<{
    /** 练哪一组：到期 / 新卡 / 在学；null = 到期+新卡混合（老口径，兜底） */
    scope?: 'due' | 'new' | 'learning' | null
    /** 嵌在首页 tab 里：结算屏按钮与空态文案不同；左右滑让位给外层 tab 翻页 */
    embedded?: boolean
    /** 是不是正在看的那个 tab —— 两个 tab 同时挂载，不是当前的那侧
     *  不许出声（自动播放）、不许抢焦点（focus 会把外层滚动容器拽过去） */
    active?: boolean
  }>(),
  { scope: null, embedded: false, active: true },
)

const router = useRouter()

/** 每落库一条会影响进度的动作（作答 / 别练它 / 已掌握）就报一次 ——
 *  首页据此实时重数 tab 数字。之前数字只在进首页时数一次，
 *  「复习了半天，进度纹丝未动」的困惑就是它。 */
const emit = defineEmits<{ (e: 'progress'): void }>()

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
const phase = ref<'playing' | 'done' | 'spell'>('playing')
/** 选项已展开（点空白处或按空格） */
const revealed = ref(false)
/** 真的做了选择或点了「我不会」 */
const submitted = ref(false)
const picked = ref('')
const shownAt = ref(0)
const flagNote = ref('')
const flagBox = ref(false)
/** 解释区详情是否展开。默认折叠，这样四个选项 + 结论仍能一屏放下。 */
const expOpen = ref(false)
const masteredFlash = ref('')

/**
 * 两种开轮方式：按 scope 组新队列（默认），或 redo 重刷刚做完那批。
 *  「随便刷」（全库随机、不看到期）在首页的「随便刷」tab，不在本组件 ——
 *  这里只管**按计划**的那一轮。
 */
const sessionId = ref('')
const stats = ref<SessionStats>({ correct: 0, wrong: 0, pending: 0, dueCorrect: 0, dueTotal: 0 })
const root = ref<HTMLElement | null>(null)
const strip = ref<HTMLElement | null>(null)

const KEYS = ['A', 'B', 'C', 'D']

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
/** 整个拼写过程里「至少错过一次」的词（累计，跨遍）。
 *  只看最后一遍的话它必然是空 —— 能收尾说明最后一遍全对 ——
 *  曾经拿「最后一遍的错词」当结算展示，那是个永远渲染不出来的死分支。 */
const spellEverMissed = ref<SpellItem[]>([])
/** 拼完一遍（全连对够）写一次小结，回到结算页展示；null = 这轮还没拼过 */
const spellSummary = ref<{ total: number; once: number; missed: SpellItem[] } | null>(null)
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
  spellEverMissed.value = []
  spellSummary.value = null
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
    if (!spellEverMissed.value.some((m) => m.id === cur.id)) {
      spellEverMissed.value = [...spellEverMissed.value, cur]
    }
  }
}

function spellNext(): void {
  if (spellIdx.value >= spellQueue.value.length - 1) {
    // ★ 走到头：这一遍写错的**再拼一遍**，只拼它们，直到全对
    const left = new Set(Object.keys(spellNeed.value))
    if (left.size) {
      spellQueue.value = spellQueue.value.filter((m) => left.has(m.id))
      spellRound.value++
      spellIdx.value = 0
      spellInput.value = ''
      spellState.value = 'ask'
      spellHint.value = false
      void nextTick(() => spellInputEl.value?.focus())
      return
    }
    /* ★ 拼写没有自己的结束页：小结写进 spellSummary，回到训练结算页一起展示。
         单独一页等于让人多看一次「结束了」——结束一次就够了。 */
    spellSummary.value = {
      total: lastRound.value.length,
      once: lastRound.value.length - spellEverMissed.value.length,
      missed: spellEverMissed.value,
    }
    phase.value = 'done'
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

/** 开一轮。redo = 重刷**刚做完那一轮**的同批卡（它们刚答过、到期日已挪走，
 *  重新按 scope 组队列组不到它们 —— 「再来一遍」必须点名重刷）。 */
async function start(redo = false): Promise<void> {
  sessionId.value = newSessionId()
  stats.value = { correct: 0, wrong: 0, pending: 0, dueCorrect: 0, dueTotal: 0 }
  spellSummary.value = null // 新一轮的训练结算不该挂着上一轮的拼写小结
  queue.value = redo
    ? lastRound.value.filter((id) => poolIds.has(id))
    : props.scope
      ? await buildScopeQueue(props.scope, SESSION_SIZE)
      : await buildQueue(SESSION_SIZE)
  steps.value = {}
  asked.value = {}
  needFix.value = {}
  passQueue.value = []
  passPos.value = 0
  loopRound.value = 0
  cursor.value = 0
  if (!queue.value.length) {
    if (redo) toast('上一轮已经不在库里了')
    // ★ 空队列如实呈现空态：不自动跳去别的练法，更不能端出「0 题」的结算屏
    //   （loadQ 对空队列会直接 phase='done'）。
    q.value = null
    phase.value = 'playing'
    return
  }
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
  // 只有缓存里那一题才沿用首次出题时选中的句子（来回翻不换句）。
  const cached = asked.value[cursor.value]
  let question: Question | null = await makeQuestion(
    queue.value[cursor.value],
    cached?.sentence.id ?? undefined,
  )
  if (!question) {
    // 刚被标记/删掉的句子：跳过这一张，别让用户看着空屏
    cursor.value++
    await loadQ()
    return
  }
  asked.value = { ...asked.value, [cursor.value]: question }
  q.value = question
  picked.value = ''
  shownAt.value = performance.now()
  revealed.value = false
  submitted.value = false
  masteredFlash.value = ''
  // 键盘要能直接答题，所以每张新题都把焦点收回页面根节点。
  // ★ 嵌在首页 tab 里时，只有当前 tab 允许抢焦点 —— 否则焦点会把外层
  //   横滑容器拽向不可见的那一页（浏览器会 scrollIntoView 聚焦元素）。
  if (props.active) root.value?.focus({ preventScroll: true })
  scrollChipIntoView()
}

/** 让当前那张在进度条里可见 —— 20 张挤在一条上，跳转后不滚一下就不知道自己在哪 */
function scrollChipIntoView(): void {
  requestAnimationFrame(() => {
    const s = strip.value
    const el = s?.querySelector('.chip.cur')
    if (!s || !el) return
    /* ★ 不能用 scrollIntoView：它会滚**所有**可滚祖先 —— 嵌在首页 tab 里时，
       不在眼前那一侧的会话也会跑这个函数，它的 scrollIntoView 把外层横滑容器
       .hroot 平滑地拽向自己那页（实测：首页先落在复习、再动画滑去学习）。
       只滚 chip 条自己：按两框中心差值写 scrollLeft，动画交给 strip 的
       scroll-behavior:smooth（只影响程序化滚动，触摸滑动不受影响）。 */
    const sr = s.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    s.scrollLeft += (er.left + er.width / 2) - (sr.left + sr.width / 2)
  })
}

/* ── 自动播放（「更多」页总开关）──
 *  时机的选择：
 *   · 新题出现读**单词** —— 先闻其声再见其形，选项还没出来，不影响思考；
 *   · 答完读**整句** —— 对错已落定，整句是语境强化（答前读句也行，
 *     但句子长、合成慢，答前读会拖住节奏；单词短，几乎无感）；
 *   · 拼写卡出现读单词 —— 听音拼词本来就是它的玩法。
 *  回看已答过的题不播（submitted 已 true）：翻旧账时出声只会吓人。
 *  ★ 嵌入首页 tab 时还要过 props.active：两个会话并排挂着，
 *    不在眼前的那一侧自动播放 = 用户盯着复习题、耳朵里是学习tab的词。 */
watch(q, (cur) => {
  if (cur && !submitted.value && props.active) autoSpeak(cur.sense.word)
})
watch(submitted, (done) => {
  if (done && q.value && props.active) autoSpeak(q.value.sentence.en)
})
watch(spellCur, (cur) => {
  if (cur && phase.value === 'spell' && props.active) autoSpeak(cur.word)
})

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
  // 「我不会」按答错处理：诚实放弃不能比乱蒙更划算
  await save('WRONG')
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
  emit('progress')
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

/* ── 90 天复习量预测（结算屏）──
   「后面还有多少」是打完一轮才会关心的问题 —— 所以它住在结算屏，
   不占训练中的屏幕。口径照搬 forecast.ts：只数能练的义项（practicePool），
   按词去重；每次进结算屏重算（刚答完的这轮已经改了进度）。 */
const forecast = ref<ForecastResult | null>(null)
const fcOpen = ref(false)

async function loadForecast(): Promise<void> {
  const [pool, prows] = await Promise.all([practicePool(), allProgress()])
  const wordOf = new Map(pool.map((s) => [s.id, s.word]))
  forecast.value = forecastDaily(
    prows.filter((p) => wordOf.has(p.senseId)),
    Math.floor(Date.now() / 1000),
    90,
    (id) => wordOf.get(id) ?? '',
  )
}

watch(phase, (p) => {
  if (p === 'done') void loadForecast()
})

/** 「别练它」：这句话有问题而且懒得改/改不了时，
 *  至少让它别再出现在练习里（flagged 的句子会被队列排除）。
 *  这仍然只是止血 —— 真正的解是上面那个「改掉这句」。 */
async function onFlag(): Promise<void> {
  if (!q.value) return
  await flagQuestion(q.value, flagNote.value)
  emit('progress') // 这句被标走，可练池可能缩了 —— 数字跟着重数
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
  if (!submitted.value) {
    toast('先答完这道题，再看词条/义项')
    return
  }
  const id = q.value?.sense.id
  pickBox.value = false
  if (id) void router.push(`/sense/${id}`)
}

function goWordPage(): void {
  if (!submitted.value) {
    toast('先答完这道题，再看词条/义项')
    return
  }
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

function onPickToken(tok: string): void {
  /* 答之前点了不能装死（用户反馈：点了没反应，不知道是坏了还是不让点）——
     不开查义（防止「查一下」变成答题的一部分），但要明说什么时候能点。 */
  if (!submitted.value) {
    toast('先作答 —— 答完句子里每个词都能点开查', 1900, true)
    return
  }
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
 *  状态在 keep-alive 里（/train 壳或首页 tab），回来还在原题、进度不丢；
 *  但**内容**不能沿用内存里那份 —— 用户在那边可能刚改过句子。 */
onActivated(() => {
  if (q.value) void loadQ()
})

async function onMastered(): Promise<void> {
  if (!q.value) return
  await markMastered(q.value.sense.id)
  emit('progress') // 掌握的卡退出到期队列 —— 数字跟着重数
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
  if (pickBox.value || peekOpen.value || aiOpen.value) return true
  const el = target as HTMLElement | null
  return !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName)
}

function onTouchStart(e: TouchEvent): void {
  // 嵌在首页 tab 里时，横向滑动属于外层 tab 翻页，这里不再翻题
  // （不拦的话，切 tab 的那一下横滑会同时把题翻了）。
  if (props.embedded) return
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

/** 开一轮：挂载即开练；scope 变了（首页 tab 切换显隐 / 词库连点两个分组
 *  复用同一路由组件）就重开一轮。 */
onMounted(() => void start())
watch(
  () => props.scope,
  (n, o) => {
    if (n !== o) void start()
  },
)
</script>

<template>
  <div
    ref="root"
    tabindex="0"
    class="tsess"
    :class="{ embedded }"
    @keydown="onKey"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
  >
    <div class="wb-wrap tsw" :class="animDir ? 'qanim in-' + animDir : ''">
      <template v-if="q">
        <!-- 进度格：一轮多题才有意义；嵌入首页 tab 时同样保留（用户拍板） -->
        <div ref="strip" class="strip">
          <button
            v-for="(sid, i) in queue"
            :key="sid + i"
            class="chip"
            :class="{
              cur: i === cursor,
              ok: steps[i]?.result === 'CORRECT',
              no: steps[i]?.result === 'WRONG' && !!steps[i]?.picked,
              skip:
                steps[i]?.result === 'PENDING' ||
                (steps[i]?.result === 'WRONG' && !steps[i]?.picked),
              todo: !steps[i],
              loop: loopRound > 0 && (needFix[i] ?? 0) > 0,
            }"
            :title="`第 ${i + 1} 题`"
            @click="goTo(i)"
          >
            {{ i + 1 }}
          </button>
        </div>
        <p class="where">
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

        <div class="qwrow">
          <div class="qw">{{ q.sense.word }}</div>
          <button
            v-if="speechOn"
            class="wb-say"
            :class="{ waiting: ttsWaiting }"
            type="button"
            aria-label="朗读单词"
            @click="speakEn(q.sense.word)"
          >
            <van-icon name="volume-o" />
          </button>
        </div>
        <div class="qtag">
          <span v-if="q.sense.pos">{{ q.sense.pos }}</span>
          <span v-if="q.ipa"> /{{ q.ipa }}/</span>
          <span v-if="q.sense.tier"> {{ q.sense.tier }}</span>
          <span v-if="q.sense.trap"> · 易错</span>
          <span v-if="!q.isDue" class="fresh"> · 新卡</span>
          <span v-if="submitted" class="qlinks">
            <button class="qnav" type="button" @click="goWordPage">词条 ›</button>
            <button class="qnav" type="button" @click="goSensePage">义项 ›</button>
          </span>
        </div>

        <!-- 例句本身不再单独挂「改」：下面一个「有问题？改」把例句、本题意思、
             选项里那几个意思全都列出来，想改哪个改哪个。
             一个入口、不挑时机（答题前答题后都能改）、不限制改什么 ——
             分成「改例句」「改选项」两个入口，等于让人先判断
             「我发现的这个问题属于哪一类」才找得到入口。 -->
        <div class="qsentrow">
          <div class="qsent">
            <!-- ★ 答完之后整句才可点：点任何一个词都能查它是什么意思（浮层），
                 想细看再进词条/义项详情；不在库里的词可以当场加入词库。
                 答之前也保持可点，但 onPickToken 只弹一句提示 —— 点了装死
                 会让人以为坏了（查义本身仍锁着，防止「查一下」变成答题）。 -->
            <MarkedText
              :text="q.sentence.en"
              :marks="q.sentence.marks"
              :form="q.sentence.form"
              :span-start="q.sentence.spanStart"
              :span-len="q.sentence.spanLen"
              pickable
              @pick="onPickToken"
            />
          </div>
          <!-- 读句子不泄题（泄题红线是「英文释义」，句子本来就是题干） -->
          <button
            v-if="speechOn"
            class="wb-say"
            :class="{ waiting: ttsWaiting }"
            type="button"
            aria-label="朗读例句"
            @click="speakEn(q.sentence.en)"
          >
            <van-icon name="volume-o" />
          </button>
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
               否则用户只看到结论、看不到正确答案是什么。
               ★ wrong 的判定不能带 !revealed（原来的 bug）：正常作答时
                 revealed=true，提交后模板切到这一块，!revealed 把红标掐死，
                 选错的选项只剩压暗、不红。picked 在「我不会」路径是空串，
                 不会误伤回放。 -->
          <!-- ★ 千万别加 class="done"：本文件底部有「结算屏 .done」，
               它带 min-height: 100dvh - 32px ≈ 730px，会把这个选项容器
               撑出 530px 的空气（坑 82）。答题完成态不需要专门 class。 -->
          <div class="opts" :class="{ replay: !revealed }">
            <button
              v-for="(opt, i) in q.options"
              :key="opt + i"
              class="opt"
              :class="{
                right: isRight(opt),
                wrong: opt === picked && !isRight(opt),
                dim: !isRight(opt) && opt !== picked,
              }"
            >
<span class="key">{{ KEYS[i] }}</span>
              <span class="tx">{{ opt }}</span>
            </button>
            <button
              class="skipopt"
              :class="{ 'skipopt-giveup': !picked }"
              type="button"
              disabled
            >
              我不会
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
                    ? picked
                      ? 'no'
                      : 'giveup'
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
            <button class="skipopt" type="button" @click="giveUp">我不会</button>
          </div>
        </template>

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
               拼过之后这里就地变成小结 —— 拼写没有自己的结束页，
               结束一次就够了。 -->
          <div v-if="spellSummary" class="spell-offer">
            <p class="so-h">拼写也练完了</p>
            <p class="so-s">
              一次拼对 {{ spellSummary.once }} / {{ spellSummary.total }} 词<template v-if="spellSummary.missed.length">，下面这些值得再看一眼</template>
            </p>
            <div v-if="spellSummary.missed.length" class="miss">
              <p v-for="m in spellSummary.missed" :key="m.id" class="miss-i">
                <b>{{ m.word }}</b> · {{ m.gloss }}
              </p>
            </div>
            <van-button plain type="primary" block round @click="startSpell">
              再拼一遍
            </van-button>
          </div>
          <div v-else-if="lastRound.length" class="spell-offer">
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
            <template v-if="embedded">
              <!-- 嵌在首页 tab 里：打完一轮后「再练一组」按 scope 重新组一轮
                   （刚答过的卡到期日已挪走，自然进不了新队列）——
                   覆盖「20 题一组之外还有到期/待学」的情况。 -->
              <van-button type="primary" block round @click="start()">再练一组</van-button>
              <van-button block round @click="start(true)">再来一遍</van-button>
            </template>
            <template v-else>
              <van-button type="primary" block round @click="start(true)">再来一遍</van-button>

              <!-- 用路由名，不写路径：首页的路径是 '/'，写成 '/home' 会匹配不到
                   任何路由 —— 表现是点了之后一片空白（既不是首页也不是报错），
                   而 /home 这种「看起来应该存在」的错字编译器不会拦。 -->
              <van-button block round @click="router.push({ name: 'home' })">回首页</van-button>
            </template>
          </div>

          <!-- 90 天复习量预测：默认收一行摘要，点开看柱状图。
               没有排期中的卡（peakDay < 0）时整条不显示。 -->
          <div v-if="forecast && forecast.peakDay >= 0" class="fcstrip">
            <button class="fchead" type="button" @click="fcOpen = !fcOpen">
              <span>{{ forecastSummary(forecast) }}</span>
              <span class="fcarrow">{{ fcOpen ? '收起' : '看图' }}</span>
            </button>
            <ForecastBars v-if="fcOpen" :data="forecast" />
          </div>
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
          <div class="sp-prog"><i :style="{ width: `${(spellIdx / spellQueue.length) * 100}%` }" /></div>

          <div class="sp-card">
            <p v-if="spellCur?.pos" class="sp-pos">{{ spellCur.pos }}</p>
            <p class="sp-gloss">{{ spellCur?.gloss }}</p>
            <!-- 听音拼词是经典玩法：喇叭读的是单词本身，不碰释义，不泄题 -->
            <button
              v-if="speechOn && spellCur"
              class="wb-say sp-say"
              :class="{ waiting: ttsWaiting }"
              type="button"
              aria-label="朗读单词"
              @click="speakEn(spellCur.word)"
            >
              <van-icon name="volume-o" /> 听一听
            </button>
            <!-- 长度是免费的底牌，一直亮着；「提示」才翻首字母 -->
            <p class="sp-hint" :class="{ on: spellHint }">
              {{ spellHint ? spellHintText : `${spellCur?.word.length ?? 0} 个字母` }}
            </p>
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
            @keyup.enter="
              spellState === 'ask' ? checkSpell() : spellState === 'wrong' ? retrySpell() : spellNext()
            "
          />

          <!-- 反馈行占位固定：答对答错都不让输入框上下跳 -->
          <p class="sp-fb" :class="spellState">
            <template v-if="spellState === 'right'">对了</template>
            <template v-else-if="spellState === 'wrong'"
              >正确答案：<b>{{ spellCur?.word }}</b></template
            >
          </p>

          <div class="sp-acts">
            <template v-if="spellState === 'ask'">
              <button class="sp-b" type="button" :disabled="spellHint" @click="spellHint = true">
                提示
              </button>
              <button class="sp-b primary" type="button" @click="checkSpell">对一下</button>
            </template>
            <template v-else-if="spellState === 'wrong'">
              <!-- 错了的第一直觉是重打一遍，所以「再试一次」是主按钮、回车也是它 -->
              <button class="sp-b primary" type="button" @click="retrySpell">再试一次</button>
              <button class="sp-b" type="button" @click="spellNext">跳过</button>
            </template>
            <!-- 答对 550ms 后自动下一个：这一瞬不摆按钮，免得闪 -->
          </div>
        </section>

        <!-- 空态：这一组没有可练的。
             嵌在首页 tab 里时不该有「回首页」按钮 —— 已经在首页了。 -->
        <template v-else>
          <p class="wb-dim empty-tip">
            <template v-if="embedded">
              {{ scope === 'due' ? '今天没有到期的复习。' : '没有待学的新词了。' }}去别的
              tab 看看，或者去词库挑一组练。
            </template>
            <template v-else>这一组没有可练的了。回首页刷两句，或者去词库看看。</template>
          </p>
          <van-button v-if="!embedded" block round @click="router.push('/')">回首页</van-button>
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
        <template v-if="submitted">
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
        </template>
        <p v-else class="wb-dim">作答后才能改这个意思，避免提前看到答案。</p>
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

        <template v-if="submitted">
          <div class="psep" />
          <button class="pickrow nav" type="button" @click="goSensePage">
            <span class="gl">看看这个意思的详情</span>
            <span class="go">›</span>
          </button>
          <button class="pickrow nav" type="button" @click="goWordPage">
            <span class="gl">看看这个词</span>
            <span class="go">›</span>
          </button>
        </template>
      </div>
    </van-popup>

    <!-- 当场改：浮层挂在页面最外层，任何时刻都能打开 -->
    <QuickEdit
      :sentence="edSentence"
      :sense="edSense"
      @saved="onEdited"
    />

    <!-- 点词查义：答完之后才可能被打开（见 onPickToken 的守卫） -->
    <WordPeek :show="peekOpen" :token="peekToken" :context="q?.sentence.en ?? ''" @close="peekOpen = false" />

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
         固定条把主行动放在同一个位置、拇指区，不管题多长都在那。
         ★ 嵌在首页 tab 里时，非当前 tab 不许亮操作条：它是 fixed 定位，
         不随外层横滑走，滑到一半会「穿帮」浮在隔壁 tab 上。 -->
    <div v-if="q && active" class="abar">
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
  padding: 6px 0 0;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  /* chip 条内的程序化滚动（scrollChipIntoView 写 scrollLeft）平滑滚动；
     只影响程序化滚动，触摸拖动不受影响 */
  scroll-behavior: smooth;
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
     padding 撑到 38px 高（上下各多 6px） */
  padding-top: 6px;
  padding-bottom: 6px;
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
  margin: 4px 0 2px;
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
  color: var(--wb-ink-2);
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

/* 单词 + 喇叭一行居中（喇叭贴词尾，不另占一行 —— 这一屏本来就紧） */
.qwrow {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
}

.qtag {
  text-align: center;
  font-size: 12px;
  color: var(--wb-ink-3);
  margin-top: 2px;
  margin-bottom: 6px;
}

.qtag .fresh {
  color: var(--wb-primary);
}

/* 题面直达词条/义项：核验「这句是不是有问题」不该先退出训练再翻词库。 */
.qlinks {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid var(--wb-line);
  vertical-align: baseline;
}

.qnav {
  border: 0;
  background: transparent;
  padding: 0 3px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-primary);
  cursor: pointer;
}

.qnav:active {
  opacity: 0.55;
}

.qsent {
  position: relative;
  text-align: center;
  font-size: 17px;
  line-height: 1.6;
  margin: 4px 0 8px;
}

/* 句子 + 喇叭：句子占满余宽保持居中观感，喇叭钉在右侧 */
.qsentrow {
  display: flex;
  align-items: flex-start;
  gap: 2px;
}

.qsentrow .qsent {
  flex: 1 1 auto;
  min-width: 0;
}

.qsentrow .wb-say {
  flex: 0 0 auto;
  margin-top: 2px;
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
  margin-bottom: 6px;
}

/* 答完之后的小提示：告诉用户「现在能点词了」。
   点词这件事**没有视觉入口**（句子就是句子），不说一句就没人会去点。 */
.peektip {
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--wb-ink-3);
  margin: -4px 0 6px;
}

.blank {
  background: var(--wb-card);
  border: 1.5px dashed var(--wb-line);
  border-radius: var(--wb-radius);
  padding: 10px;
  text-align: center;
  color: var(--wb-ink-3);
  font-size: 13px;
  cursor: pointer;
}

/* ★ 一律 1 列：每个选项独占一行。长释义在 2 列里折行会把那一行
   grid 撑得高低不齐（实测 A 框"文字折行 + 下面空一块"），1 列后
   每个选项自己长自己的，文字完整可读、行间高度一致。 */
.opts {
  display: grid;
  grid-template-columns: 1fr;
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
  /* 选项全文必须永远可读（用户实测：钳两行时**作答前**就读不全释义，
     等于让人瞎选）。不再 clamp —— 页面本来就滚动，选项长就换行，
     「四行变五行」不是缺陷，看不全才是。 */
  display: block;
  line-height: 1.35;
}

/* 四个选项下面的长条「我不会」：不参与 ABCD 判分，按 WRONG 记。
   类名不能叫 .skip —— 进度格已有 .chip.skip。 */
.skipopt {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 46px;
  padding: 11px;
  border: 1.5px dashed #c4c8d3;
  border-radius: var(--wb-radius);
  background: #f7f8fb;
  color: var(--wb-ink-2);
  font-family: inherit;
  font-size: 14.5px;
  font-weight: 600;
  cursor: pointer;
}

.skipopt:active {
  border-color: var(--wb-primary);
  background: #eef0f7;
  color: var(--wb-primary);
}

/* 答过之后「我不会」仍留在选项下，保持布局不跳，但不再可点 */
.skipopt:disabled {
  cursor: default;
  opacity: 0.8;
}

/* 走「我不会」这条路：橙色标出这次诚实放弃，而不是当成某个错选项的红色 */
.skipopt-giveup {
  border-color: var(--van-warning-color);
  background: #fff7e8;
  color: #8a5a12;
  opacity: 1;
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

/* 会话本体是自己的滚动容器，两种壳通用：
   · /train 薄壳是 100dvh 的 flex 列 —— flex:1 + min-height:0 吃掉顶栏以外的高度；
   · 首页 tab 页是普通块 —— height:100% 直接顶满页格。
   两套写法在同一元素上互不干扰（flex 项的 height 会被 flex 算法收编）。
   键盘避让（keyboard.ts keepVisible）也只认这一个 scroller。 */
.tsess {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  outline: none;
  -webkit-overflow-scrolling: touch;
}

/* 固定操作条 + 键盘 + 安全区的让位：内容底部要长出这么多，
   最后一张题的选项才不会被压在条子底下、拼写输入框才有余量滚到键盘上方。 */
.tsw {
  padding-bottom: calc(64px + var(--wb-safe-bottom) + var(--kb, 0px));
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

/* 没选中的其它项：答完后**不**压暗。
   ★ 用户实测：半透明让没选中的释义读起来发灰、像"看不全"。
   只有对错高亮就足够一眼分明，其它项保持原色才是"正常显示"。 */
.opt.dim {
  /* 原 opacity: 0.55 已删 */
}

.exp {
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 8px 10px;
  margin-top: 8px;
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

.exp .st.giveup {
  color: var(--van-warning-color);
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

/* 「选项不对？改」：一个入口，放在选项下面。
   不放进选项里 —— 四个选项各挂一个「改」，用户得先在心里挑出
   「是哪一条不对」才找得到它，判断成本原封不动地推回给了用户。 */
.fixrow {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 6px;
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
  border-radius: 18px;
  padding: 22px 18px;
  text-align: center;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.06);
}

.sp-pos {
  display: inline-block;
  margin: 0;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(79, 70, 229, 0.08);
  font-size: 11px;
  color: var(--wb-primary);
}

.sp-gloss {
  margin: 8px 0 0;
  font-size: 22px;
  line-height: 1.5;
  font-weight: 650;
  color: var(--wb-ink);
}

/* 拼写卡的喇叭带文字「听一听」，比纯图标小一号 */
.sp-say {
  margin-top: 8px;
  font-size: 13px;
}

.sp-hint {
  margin: 10px 0 0;
  font-size: 12.5px;
  letter-spacing: 1px;
  color: var(--wb-ink-3);
}

.sp-hint.on {
  color: var(--wb-primary);
  font-weight: 600;
}

/* 进度细条：拼写是快节奏练习，进度只给一条线，不抢戏 */
.sp-prog {
  height: 3px;
  border-radius: 999px;
  background: var(--wb-line);
  overflow: hidden;
  margin-bottom: 14px;
}

.sp-prog i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--wb-primary);
  transition: width 0.25s ease;
}

.sp-input {
  flex: 0 0 auto;
  margin-top: 14px;
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  border: 1.5px solid var(--wb-line);
  border-radius: 14px;
  background: var(--wb-card);
  font-family: inherit;
  font-size: 22px;
  text-align: center;
  letter-spacing: 1px;
  color: var(--wb-ink);
  outline: none;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
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

/* 反馈行占位固定（min-height），答对答错输入框都不跳 */
.sp-fb {
  margin: 10px 0 0;
  min-height: 22px;
  font-size: 14px;
  text-align: center;
  color: var(--wb-ink-3);
}

.sp-fb.right {
  color: #12a05c;
  font-weight: 650;
}

.sp-fb.wrong {
  color: #c1291f;
}

.sp-fb.wrong b {
  font-size: 17px;
  letter-spacing: 0.5px;
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
  padding: 14px 10px;
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  background: var(--wb-card);
  font-family: inherit;
  font-size: 15px;
  color: var(--wb-ink);
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.sp-b:disabled {
  opacity: 0.45;
}

.sp-b.primary {
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  color: #fff;
  font-weight: 600;
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

/* 嵌入首页 tab 时结算屏按**页格**算，不按整屏 100dvh：
   页格已经扣掉状态栏让位（.hpage 的 padding-top）和 tabbar，再按 dvh 算
   就会多长出约 90px —— 收起态就要滚，预测条一展开更「高度超过屏幕」
   （用户真机实测反馈）。收紧间距后收起态正好一屏放下，展开态才滚动。 */
.tsess.embedded .done {
  min-height: 0;
  gap: 14px;
  padding: 8px 4px 12px;
}

.done-k {
  margin: 0;
  font-size: 14.5px;
  color: var(--wb-ink-3);
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

/* 90 天复习量预测条：收在结算屏底部的一行摘要，点开才是柱状图 */
.fcstrip {
  width: 100%;
}

.fchead {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 0;
  background: transparent;
  padding: 4px 2px 6px;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--wb-ink-3);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.fchead .fcarrow {
  flex: 0 0 auto;
  color: var(--wb-primary);
}

</style>
