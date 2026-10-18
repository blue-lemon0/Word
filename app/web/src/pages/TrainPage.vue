<script setup lang="ts">
/** 训练页 —— 交互沿用旧版那一套（设计稿 §10.1），只把数据源换成新内容模型。
 * 四个判断照旧保留：
 *   目标词 <mark> 高亮 / 答案区才给英文释义 / 「我不会」在选项之前 /
 *   「这句有问题」随手标，标了不再出现。
 *
 *  队列来源：?solo=<senseId> 是错题板的单挑入口（页内不提供单挑按钮 ——
 *  知道要练哪个意思，选题就成了送分）。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MarkedText from '../components/MarkedText.vue'
import {
  buildQueue,
  buildRandomQueue,
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
/** 已作答的卡片，**按题号稀疏存放**（steps[i] 是第 i 题的作答）。
 *
 *  存成数组会出事：用户可以往前跳到一张还没答的题（比如跳过第 2 题去做第 3 题），
 *  这时中间就缺了一格。用数组的话 `steps.slice(0, cursor)` 会把第 2 题的槽位
 *  让给第 3 题，之后所有卡片的作答全部错位。用稀疏对象就没有这个问题 ——
 *  没答就是 undefined，天然表示「这一格还没有答案」。 */
const steps = ref<Record<number, Step>>({})
/** 光标：当前显示第几张 */
const cursor = ref(0)
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
const phase = ref<'playing' | 'done'>('playing')
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
type Mode = 'due' | 'random' | 'redo'

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

/** 可练池的 id 集合：重刷之前要确认那些卡还在（被标记/删掉的就不该再出现） */
let poolIds = new Set<string>()
void practicePool().then((pool) => {
  poolIds = new Set(pool.map((s) => s.id))
})

const mode = ref<Mode>('due')

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
  queue.value =
    which === 'random'
      ? await buildRandomQueue(SESSION_SIZE, only)
      : which === 'redo'
        ? lastRound.value.filter((id) => poolIds.has(id))
        : await buildQueue(SESSION_SIZE, only)
  if (!queue.value.length) {
    if (which === 'redo') {
      toast('上一轮已经不在库里了')
      queue.value = await buildRandomQueue(SESSION_SIZE, only)
    } else {
      toast('今天没有到期的 —— 换个练法试试')
      queue.value = await buildRandomQueue(SESSION_SIZE, only)
      mode.value = 'random'
    }
  }
  steps.value = {}
  asked.value = {}
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

  // 回看：直接还原那张卡的原样，不重新出题
  const step = steps.value[cursor.value]
  if (step) {
    q.value = step.q
    picked.value = step.picked
    revealed.value = true
    submitted.value = step.result != null
    stats.value = { ...step.stats }
    masteredFlash.value = step.masteredFlash
    return
  }

  // 新题：出过一次就缓存，回来看还是同一道
  const cached = asked.value[cursor.value]
  let question: Question | null = cached
  if (!question) {
    question = await makeQuestion(
    queue.value[cursor.value],
    pinUsed ? undefined : pinnedSentence.value,
  )
  pinUsed = true
    if (!question) {
      // 刚被标记/删掉的句子：跳过这一张，别让用户看着空屏
      cursor.value++
      await loadQ()
      return
    }
    asked.value = { ...asked.value, [cursor.value]: question }
  }
  q.value = question
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
}

/** 下一题：优先往前走（回看时是往历史后面走），走到头就是继续答新的。 */
async function next(): Promise<void> {
  cursor.value++
  await loadQ()
}

async function onFlag(): Promise<void> {
  if (!q.value) return
  await flagQuestion(q.value, flagNote.value)
  flagBox.value = false
  await next()
}

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
const SWIPE_MIN = 56
const touch = { x: 0, y: 0, locked: false, dx: 0, dy: 0 }

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t) return
  touch.x = t.clientX
  touch.y = t.clientY
  touch.locked = false
  touch.dx = 0
  touch.dy = 0
}

function onTouchMove(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t) return
  touch.dx = t.clientX - touch.x
  touch.dy = t.clientY - touch.y
  if (!touch.locked && Math.abs(touch.dx) > 10) {
    // 一旦判定为横向手势，阻止纵向滚动；否则页面会跟着一起动，手势被吃掉
    if (Math.abs(touch.dx) > Math.abs(touch.dy)) touch.locked = true
  }
}

function onTouchEnd(): void {
  if (!touch.locked) return
  const { dx, dy } = touch
  touch.locked = false
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dy) > Math.abs(dx) * 0.8) return
  // 往左滑 = 下一题，往右滑 = 上一题
  if (dx < 0) {
    if (submitted.value || reviewing.value) void next()
  } else {
    void prev()
  }
}

const accuracy = computed(() =>
  stats.value.correct + stats.value.wrong === 0
    ? '—'
    : Math.round((stats.value.correct / (stats.value.correct + stats.value.wrong)) * 100) + '%',
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
  () => [route.query.solo, route.query.sent],
  () => {
    if (route.query.solo) void start('due')
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
        <h1>{{ solo ? '单挑' : '训练' }}</h1>
        <van-button size="mini" plain @click="router.push('/board')">错题板</van-button>
      </div>
    </header>

    <div class="wb-wrap">
      <template v-if="q">
        <!-- 一排可点的进度格：既回答了「我在第几个」，也回答了「怎么跳」。
             单纯的 "3 / 20" 文字只解决了前者，而且字小、滚下去就看不见；
             一排格子能一眼看出哪些做对、哪些错、哪些空着，还能直接点回去。 -->
        <div ref="strip" class="strip">
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
          <span v-else-if="jumpedAhead" class="rv">· 跳过题</span>
          <span class="wb-sp" />
          已答 {{ answeredCount }} · 对 {{ stats.correct }} · 错 {{ stats.wrong }}
        </p>

        <div class="qw">{{ q.sense.word }}</div>
        <div class="qtag">
          <span v-if="q.sense.pos">{{ q.sense.pos }}</span>
          <span v-if="q.ipa"> /{{ q.ipa }}/</span>
          <span v-if="q.sense.tier"> {{ q.sense.tier }}</span>
          <span v-if="q.sense.trap"> · 易错</span>
          <span v-if="!q.isDue" class="fresh"> · 新卡</span>
        </div>

        <div class="qsent">
          <MarkedText
            :text="q.sentence.en"
            :form="q.sentence.form"
            :span-start="q.sentence.spanStart"
            :span-len="q.sentence.spanLen"
          />
        </div>

        <template v-if="!revealed">
          <p class="qhint">想清楚这个词在这里的意思</p>
          <div class="blank" @click="reveal">— 点击空白处显示选项 —</div>
        </template>

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

          <!-- 解释区：默认只给结论 + 一个「详情」开关。
               以前是把对错 + 释义 + 英文 + 翻译 + 笔记 + 三个按钮一次性全展开，
               四个选项一出现就必然超出屏幕一屏多，用户得翻页才看得到
               「下一题」—— 在手机上等于没法用。
               现在：结论常驻（这是答题后最需要的信息），其余折叠。

               v-if="submitted" 不能省：没作答时里面是空的，
               渲染出来就是一张只有「详情」按钮的空白卡片。 -->
          <div v-if="submitted" class="exp" :class="{ open: expOpen }">
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

              <!-- 这两个是「标记类」操作，留在解释区里；
                   主行动（下一题 / 上一题）在底部固定条，不放这里 -->
              <div v-if="!reviewing" class="line">
                <van-button size="small" plain @click="onMastered">已掌握</van-button>
                <van-button size="small" plain @click="flagBox = !flagBox">这句有问题？</van-button>
              </div>

              <div v-if="flagBox" class="flagbox">
                <van-field v-model="flagNote" placeholder="问题是什么（可空）" label="" />
                <van-button size="small" @click="onFlag">提交</van-button>
              </div>
            </template>
          </div>
        </template>
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
          <div class="done-btns">
            <!-- ★ 这里原来是 @click="start"，也就是**按到期重新组一轮**。
                 刚答过的卡 dueAt 挪到了明天、reps 也大于 0，于是 buildQueue
                 把它们全部排除 —— 点了「再来一轮」结果队列是空的，
                 表现就是「按了没反应 / 什么都不变」。
                 「再���一遍」要的是**重刷刚做完的那批**，所以用 redo。 -->
            <van-button type="primary" block round @click="start('redo')">再来一遍</van-button>
            <van-button block round @click="router.push('/scan')">扫读例句</van-button>
            <van-button block round @click="start('random')">随便练</van-button>
            <!-- 用路由名，不写路径：首页的路径是 '/'，写成 '/home' 会匹配不到
                 任何路由 —— 表现是点了之后一片空白（既不是首页也不是报错），
                 而 /home 这种「看起来应该存在」的错字编译器不会拦。 -->
            <van-button block round @click="router.push({ name: 'home' })">回首页</van-button>
          </div>
        </section>

        <!-- 开场屏：把「今天没到期」从死胡同变成一个选择。
     过去只有「准备开始」一个按钮，而今天的题答完之后队列是空的 ——
     「今天没有到期的」这句话后面没有任何可做的事，人就闲着了。
     现在给出三条路：按计划、随便抽、以及像报纸一样扫。 -->
        <section v-else class="wb-card center modes">
          <h2>{{ solo ? '单挑这个意思' : '怎么练' }}</h2>
          <p v-if="!solo" class="sub">按空格显示选项，A/B/C/D 选，Enter 下一个</p>
          <div class="mlist">
            <button class="mitem pri" @click="start('due')">
              <b>按计划</b><span>今天到期的 + 没学过的新卡</span>
            </button>
            <button class="mitem" @click="start('random')">
              <b>随便练</b><span>全库随机抽，不看到期</span>
            </button>
            <button class="mitem" @click="router.push('/scan')">
              <b>扫读例句</b><span>像看报纸一样扫，不懂哪句点哪句</span>
            </button>
          </div>
        </section>
      </template>
    </div>

    <!-- ★ 固定在底部的主操作条。
         之前的「再来一个」按钮在解释卡里，只有答完题才出现，而且位置在
         页面最下面 —— 手机上答完题要往下滑一屏才找得到，于是「背单词不方便」
         的第一症结就是这个按钮根本不在拇指够得到的地方。
         固定条把主行动放在同一个位置、拇指区，不管题多长都在那。 -->
    <div v-if="q" class="abar">
      <!-- 回看中：左边是回到当前位置，右边继续往后翻 -->
      <template v-if="reviewing">
        <van-button size="small" plain :disabled="cursor === 0" @click="prev">上一题</van-button>
        <van-button size="small" type="primary" @click="resume">
          继续（第 {{ frontier + 1 }} 题）
        </van-button>
      </template>
      <!-- 还没出选项：主动作是「显示选项」，副动作是「我不会」 -->
      <template v-else-if="!revealed">
        <van-button size="small" plain @click="giveUp">我不会</van-button>
        <van-button class="wide" type="primary" @click="reveal">显示选项</van-button>
      </template>
      <!-- 已出选项但还没选：等着点选项，这里只放后退 -->
      <template v-else-if="!submitted">
        <van-button size="small" plain :disabled="cursor === 0" @click="prev">上一题</van-button>
        <span class="apick">点上面四个选项作答</span>
      </template>
      <!-- 答完了：主行动前进，左边给回看 -->
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
  text-align: center;
  font-size: 17px;
  line-height: 1.6;
  margin: 8px 0 14px;
}

.qhint {
  text-align: center;
  font-size: 12.5px;
  color: var(--wb-ink-2);
  margin-bottom: 8px;
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

.line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--wb-line);
  flex-wrap: wrap;
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

.center {
  text-align: center;
  padding: 30px 16px;
  margin-top: 24px;
}

.center h2 {
  margin: 6px 0;
  font-size: 17px;
}

.sub {
  color: var(--wb-ink-3);
  font-size: 13px;
  margin: 4px 0 16px;
}

/* 三种练法：竖排整宽的行，每行 = 一个标题 + 一句「它到底怎么练」。
   不做成三张小卡并排 —— 手机上并排每张只有 100px 宽，那行说明必须缩成两行，
   而「按计划 / 随便 / 扫读」这三个词本身不足以让人判断选哪个。 */
.mlist {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.mitem {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  border: 1px solid var(--wb-line);
  background: var(--wb-bg);
  border-radius: var(--wb-radius);
  padding: 12px 14px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.mitem b {
  font-size: 15px;
  color: var(--wb-ink);
}

.mitem span {
  font-size: 12px;
  color: var(--wb-ink-2);
}

.mitem.pri {
  border-color: var(--wb-primary);
  background: rgba(79, 70, 229, 0.06);
}

.mitem:active {
  background: var(--wb-line);
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