<script setup lang="ts">
/** 首页 = 一排**平级 tab**（顶部小巧胶囊 tab 条 + 左右滑翻页）：
 *
 *  「复习」= 到期队列、「学习」= 新卡队列 —— 都是 TrainSession 整轮本体
 *          嵌进来（与 /train 同一套判分链路）；数量为 0 的 tab 整个隐藏。
 *          复习与学习**平级**，不强制谁先谁后（用户拍板：想先学完再复习也行）。
 *  「随便刷」= 随机一题一屏（上下滑换下一题），判分照旧写进度；
 *          它自成一体，不与整轮共享队列。队列里以约 1/10 的频率混着
 *          **扫读卡**（3 句、每句目标词不同、先心猜再翻开自评勾叉，
 *          抖音信息流式插入位）—— 没有独立的扫读 tab。
 *
 *  默认落点：有到期 → 复习；无到期有待学 → 学习；都没有 → 随便刷。
 *
 *  ★ tab 显隐只在**进入首页时**刷新（onMounted/onActivated 数一次），
 *    打完一轮不立即刷新 —— 否则「复习」tab 会在结算屏亮着的瞬间整个消失，
 *    把结算屏吞掉。离开首页再回来才重新数。
 */
import { computed, nextTick, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import WordPeek from '../components/WordPeek.vue'
import QuestionBox from '../components/QuestionBox.vue'
import ScanCard from '../components/ScanCard.vue'
import QuickEdit from '../components/QuickEdit.vue'
import AiSheet from '../components/AiSheet.vue'
import TrainSession from '../components/TrainSession.vue'
import { replaceSentence } from '../ai/actions'
import { aiReady } from '../ai/config'
import { describeAiError, type AiResult } from '../ai/types'
import { autoSpeak } from '../speech'
import type { Question } from '../quiz'
import type { Sense, Sentence } from '../types'
import { allProgress } from '../db'
import { buildRandomQueue, makeQuestion, practicePool, type FeedEntry } from '../quiz'
import { useSnapPager } from '../scroll-pager'

defineOptions({ name: 'HomePage' })

const router = useRouter()

/**
 * 两个数：**今天该复习的词数** 与 **待学的词数**，决定「复习 / 学习」tab 显隐
 * 与 tab 上的小数字。-1 = 还没数完（首帧先不摆 tab，避免「先亮随便刷、
 * 再跳去复习」的闪）。
 *
 * ★ 口径必须和「点进去那一组」完全一致 —— 数字来自 A、跳转到 B 时，
 *   人看到「21」进去却是空的（这个错踩过）。所以统一按**词**数、按「这个词最紧要
 *   的那个义项的桶」归类，与词库页五个桶同一套口径。
 */
const dueN = ref(-1)
const wordsN = ref(-1)

interface HomeTab {
  id: 'due' | 'new' | 'feed'
  label: string
  /** tab 名后面跟的小数字（复习/学习才带） */
  n?: number
}

/** 平级 tab 清单：复习/学习按数量显隐，随便刷恒在 */
const tabs = computed<HomeTab[]>(() => {
  if (dueN.value < 0 || wordsN.value < 0) return []
  const list: HomeTab[] = []
  if (dueN.value > 0) list.push({ id: 'due', label: '复习', n: dueN.value })
  if (wordsN.value > 0) list.push({ id: 'new', label: '学习', n: wordsN.value })
  list.push({ id: 'feed', label: '随便刷' })
  return list
})

async function loadNums(): Promise<void> {
  // ★ 用**能练的义项池**（有例句、没被标记）来数，而不是整张 senses 表：
  //   没例句的词进不了出题池，把它们算进「待学」就会出现「显示 1 个、进去 0 题」。
  const [senses, prows] = await Promise.all([practicePool(), allProgress()])
  const pmap = new Map(prows.map((p) => [p.senseId, p]))
  const now = Math.floor(Date.now() / 1000)
  const rankOf = (senseId: string): number => {
    const p = pmap.get(senseId)
    if (!p || p.reps === 0) return 2
    if (p.mastered && !p.rusty) return 3
    return p.dueAt <= now ? 0 : 1
  }
  const buckets = new Map<string, number>()
  for (const s of senses) {
    const r = rankOf(s.id)
    const cur = buckets.get(s.word)
    if (cur === undefined || r < cur) buckets.set(s.word, r)
  }
  let due = 0
  let fresh = 0
  for (const r of buckets.values()) {
    if (r === 0) due++
    else if (r === 2) fresh++
  }
  dueN.value = due
  wordsN.value = fresh
}

/* ── tab 翻页容器（页码↔滚动同步、keep-alive 恢复都在 useSnapPager 里，坑 62/71）── */
const hPager = useSnapPager('x', { max: () => tabs.value.length - 1 })
const pane = hPager.page
const rootEl = hPager.el
const goPane = hPager.goTo
const onScrollRoot = hPager.onScroll

/** 默认落点：有到期先复习；没到期有待学就学习；都没有就随便刷 */
function defaultIdx(list: HomeTab[]): number {
  const prefer = dueN.value > 0 ? 'due' : wordsN.value > 0 ? 'new' : 'feed'
  const i = list.findIndex((t) => t.id === prefer)
  return i >= 0 ? i : 0
}

/* tab 集合随数量变化时，按 **id** 重映射当前页：
   「复习」tab 消失时不能让人留在原地（位置还在、内容换了）—— 退回默认落点；
   还在的 tab 换了下标也要跟着搬过去（不带动画，搬位置不是翻页）。
   flush:post —— 等 tab 页格真正渲染出来再跳，否则容器还是空的，
   scrollLeft 会被浏览器夹回 0。 */
watch(
  tabs,
  (list, old) => {
    if (!list.length) return
    const prevId = old?.[pane.value]?.id
    const i = prevId ? list.findIndex((t) => t.id === prevId) : -1
    goPane(i >= 0 ? i : defaultIdx(list), false)
  },
  { flush: 'post' },
)

/** 空态等处的「去学新词」：不再跳路由，切到学习 tab（不在就不该出现这个按钮） */
function goTab(id: HomeTab['id']): void {
  const i = tabs.value.findIndex((t) => t.id === id)
  if (i >= 0) goPane(i)
}

/* ── 随便刷：一题一屏（随机），队列里约 1/10 的位置是扫读卡（quiz.ts 组队列时插入）── */
/* ★ 它不管到期、不管复习计划，也不和「复习/学习」那一轮共享队列。 */
const queue = ref<FeedEntry[]>([])
const serial = ref(0)
/* 初始就是 loading（坑 80）：onMounted 必走 newBatch，若初始 false，
   首帧 DOM 会先摆出一副「空池」形状再被 loading 顶掉 —— 又是一次闪。 */
const loading = ref(true)
const done = ref(0)
const right = ref(0)

const cur = computed(() => queue.value[idx.value] ?? null)
const total = computed(() => queue.value.length)

/** 竖滑一屏一题。
 *  keep-alive 回来的位置恢复在 useSnapPager 里（坑 62/71），页面不手写。 */
const qPager = useSnapPager('y', { max: () => total.value - 1 })
const idx = qPager.page
const qIntent = qPager.intent
const qVisual = qPager.visual
const qscroll = qPager.el
const onQScroll = qPager.onScroll

/** ★ `.qscroll` 在 tab 的 `v-for` 里，**不能用 `ref="qscroll"`**：Vue 对
 *  v-for 里的字符串 ref 会按 ref_for 收集成数组，`qPager.el.value` 拿到的是
 *  `[HTMLElement]` 而不是元素 —— 于是 goTo 里 `e.scrollTo` 是 undefined，
 *  「下一题」点下去静默无反应；onScroll 里 `e.isConnected` 是 undefined，
 *  直接早退，滑动也不更新页码（不报错，最难查的那种）。
 *  函数 ref 直接收单个元素，避开 v-for 的收集行为。 */
function setQScrollEl(el: unknown): void {
  qscroll.value = (el as HTMLElement | null) ?? null
}

/** 每一页的呈现状态（决定底栏显示哪两个按钮）。
 *
 *  ★ 必须**按页**存，不能只存一份「当前页」：翻回一页已经作答的题时，
 *    子组件不会重新 emit（它还挂着），只存一份就会被翻页逻辑重置成
 *    「未作答」—— 底栏显示「显示选项」，点下去反而把底栏清空。
 *    QuestionBox 每次装载都会报一次状态，所以重挂的页也能对上。
 */
const boxStates = reactive(new Map<number, { revealed: boolean; submitted: boolean }>())
/* 扫读卡挂载即 revealed（它没有「显示选项」阶段），组件还没报状态的那一瞬
   用 entry 类型兜底 —— 不然底栏会闪一帧「我不会 / 显示选项」。 */
const boxState = computed(
  () =>
    boxStates.get(idx.value) ??
    (cur.value?.kind === 'scan'
      ? { revealed: true, submitted: false }
      : { revealed: false, submitted: false }),
)

/* ── 题目预取（坑 78）──
   QuestionBox 自己挂载后才 makeQuestion：快速连翻时每一页都先亮「出题…」
   空壳， IndexedDB 那一跳在真机上足够被眼睛看见。修法照列表的预加载思路：
   外壳提前把前后几页的题出好，子组件拿到现成的直接用。
   键是**队列下标**（不是 senseId）：同一批里同一个义项出现两次也不串。 */
const preMade = reactive(new Map<number, Question>())
const preInflight = new Set<number>()

async function prefetchOne(i: number): Promise<void> {
  const entry = queue.value[i]
  // 扫读卡的句子在组队列时就已带全（buildRandomQueue 一次取好），无需预取
  if (!entry || entry.kind !== 'q' || preMade.has(i) || preInflight.has(i)) return
  const sid = entry.senseId
  preInflight.add(i)
  try {
    const q = await makeQuestion(sid)
    // 等题途中用户可能已「换一批」—— 下标对不上就扔掉，别把旧批的题塞进新批
    const now = queue.value[i]
    if (q && now && now.kind === 'q' && now.senseId === sid) preMade.set(i, q)
  } finally {
    preInflight.delete(i)
  }
}

/** 以 n 为中心预热窗口：前后各 5 页（用户 2026-10-20：前后各 2 只是底线，
 *  预取要大方 —— makeQuestion 就是几条 IndexedDB 读，成本可忽略；
 *  渲染窗口 ±3，预取 ±5 留出余量，快速甩动落点也在热区内）。
 *  边界由 prefetchOne 自己挡：队列头尾 sid 为空直接返回、
 *  「换一批」后下标对不上旧题直接扔。 */
const PRE_RANGE = 5
function prefetchAround(n: number): void {
  for (let d = -PRE_RANGE; d <= PRE_RANGE; d++) void prefetchOne(n + d)
}

watch(idx, (n) => prefetchAround(n))
/* 甩动途中预取跟着视线走（坑 81）：落定前 idx 不动，但可视页早已翻远 */
watch(qVisual, (n) => prefetchAround(n))

async function newBatch(): Promise<void> {
  loading.value = true
  /* 换一批 = 换一代：键里带 serial，上一批的组件不会被同名键复用，
     避免「同一个义项恰好落在同一个下标」时沿用上一批的作答状态。 */
  serial.value++
  preMade.clear()
  boxStates.clear()
  scanMarks.clear()
  try {
    queue.value = await buildRandomQueue(50)
    /* 第一题**备好再亮屏**：否则用户看到的是「组题… → 出题… → 内容」
       三段跳（坑 78 的另一半 —— 打开 App 那一刻的闪烁）。 */
    await prefetchOne(0)
  } finally {
    loading.value = false
  }
  prefetchAround(0)
  idx.value = 0
  done.value = 0
  right.value = 0
  resultAt.value = {}
  await nextTick()
  const el = qscroll.value
  if (el) el.scrollTop = 0
}

/** 当前这页题面组件的引用 —— 目前只用来在「AI 换一句」之后让那一页重新出题 */
const boxes = new Map<number, { reload: () => void }>()

function setBox(i: number, el: unknown): void {
  if (el) boxes.set(i, el as never)
  else boxes.delete(i)
}

/** 把「AI 换一句」也搬到随便刷：作答后发现这句不好，当场换（和背单词页同一个动作）。
 *  换完重新出这一题 —— 不然解析里还挂着旧例句。 */
const aiOn = aiReady
const aiOpen = ref(false)
const aiBusy = ref(false)
const aiResult = ref<AiResult | null>(null)
const aiError = ref('')
/** AI 换句是从哪一页发起的：换完要重载那一页，不能跟着当前 idx 跑 */
const aiPage = ref<number | null>(null)

async function aiReplaceAt(i: number): Promise<void> {
  const q = preMade.get(i)
  if (!q) return
  aiPage.value = i
  aiError.value = ''
  aiResult.value = null
  aiOpen.value = true
  aiBusy.value = true
  try {
    const sid = q.sentence.id
    if (sid == null) return
    aiResult.value = await replaceSentence(sid, '首页觉得这句别扭')
  } catch (e) {
    aiError.value = describeAiError(e)
  } finally {
    aiBusy.value = false
  }
}

function onAiApplied(): void {
  aiOpen.value = false
  const page = aiPage.value
  aiPage.value = null
  if (page != null) boxes.get(page)?.reload()
}

/** 当前题的完整对象（改内容、查词都要用它）。
 *
 *  ★ 从 preMade 派生，不能只在 onLoaded 那一拍写一份 ref：
 *    窗口 ±3 里的页翻过去时组件并不重挂、也就不会再 emit loaded，
 *    于是「改例句 / 改释义 / AI 换一句」会对着**上一题的句子**动手。
 */
const curQ = computed<Question | null>(() => preMade.get(idx.value) ?? null)
function onLoaded(i: number, q: Question): void {
  // 组件自己出的题（含 AI 换句后的 reload）也回写进预取缓存 ——
  // 不然往回翻时拿到的还是换句之前的那道旧题
  preMade.set(i, q)
}

const edSentence = ref<Sentence | null>(null)
const edSense = ref<Sense | null>(null)

/** 「有问题？改」：和背单词页同一套 QuickEdit，只是入口更轻。
 *  入口绑死页码：翻页后解析里的按钮仍改**它那一页**的句子/释义。 */
function openFixAt(i: number, what: 'sentence' | 'sense'): void {
  const q = preMade.get(i)
  if (!q) return
  edSentence.value = what === 'sentence' ? q.sentence : null
  edSense.value = what === 'sense' ? q.sense : null
}

/** 组件回报状态：按页存（翻页不重置，见 boxStates 的注释） */
function onBoxState(i: number, st: { revealed: boolean; submitted: boolean }): void {
  boxStates.set(i, st)
  if (i !== idx.value) return
  // 答完之后内容变长：把这一页滚回顶部，别让人一睁眼只看到 ABCD 和解析
  if (st.submitted) {
    void nextTick(() => {
      const page = qscroll.value?.querySelectorAll('.qpage-in')[i] as HTMLElement | undefined
      if (page) page.scrollTop = 0
    })
  }
}

/* ── 自动播放（「更多」页总开关）—— 与 TrainSession 同一套时机：
 *  新卡出现读单词（短、几乎无感），答完读整句（语境强化）。
 *  回看已答的卡不播：翻旧账时出声只会吓人。
 *  ★ 只有「随便刷」是当前 tab 时才播：复习/学习 tab 里嵌的 TrainSession
 *    也有自己的自动播放，两边不抢着出声。 */
const feedActive = computed(() => tabs.value[pane.value]?.id === 'feed')
watch(curQ, (cur) => {
  if (cur && !boxState.value.submitted && feedActive.value) autoSpeak(cur.sense.word)
})
watch(
  () => boxState.value.submitted,
  (done) => {
    if (done && curQ.value && feedActive.value) autoSpeak(curQ.value.sentence.en)
  },
)

/* 底栏取消后不再需要页面去指挥卡片：显示选项、我不会都在 QuestionBox 里，
   翻页只走竖滑（goBy 的那两个包装已经没有人调了，删掉免得留死代码）。 */

/** 每题只记一次结果（上下滑来回不会重复计数）。
 *  同时存 picked：QuestionBox 重挂时要靠它把「当时选了哪个」还原回来。 */
const resultAt = ref<
  Record<
    number,
    { result: 'CORRECT' | 'WRONG' | 'PENDING'; picked: string; outcome?: Question['outcome'] }
  >
>({})

function onAnsweredAt(
  i: number,
  a: { result: 'CORRECT' | 'WRONG' | 'PENDING'; picked: string; outcome?: Question['outcome'] },
): void {
  if (resultAt.value[i]) return
  resultAt.value = { ...resultAt.value, [i]: a }
  done.value++
  if (a.result === 'CORRECT') right.value++
}

/* ── 扫读卡的自评存盘：按页存每一句的勾/叉。
 *  窗口式渲染会卸载远处的页，翻回来时 ScanCard 靠这份存盘恢复原样 ——
 *  不恢复的话已评的句又能再点，recordAnswer 会落第二次（SRS 记两遍）。
 *  与 resultAt 之于 QuestionBox 是同一个坑的同一味药。 */
const scanMarks = reactive(new Map<number, Array<'CORRECT' | 'WRONG' | null>>())

function onScanVerdict(i: number, v: { index: number; result: 'CORRECT' | 'WRONG' }): void {
  const entry = queue.value[i]
  if (!entry || entry.kind !== 'scan') return
  const arr = scanMarks.get(i) ?? entry.items.map(() => null)
  if (arr[v.index]) return // 这句已评过（ScanCard 已评锁定不会再 emit，这行是双保险）
  arr[v.index] = v.result
  scanMarks.set(i, arr)
  done.value++
  if (v.result === 'CORRECT') right.value++
}

/* ── 查词浮层 / 跳转 ── */
const peekOpen = ref(false)
const peekToken = ref('')

function pick(w: string): void {
  peekToken.value = w
  peekOpen.value = true
}

function goWord(w: string): void {
  void router.push(`/word/${encodeURIComponent(w)}`)
}

/** keep-alive 回来：重新数一次（tab 显隐只在这时刷新，见文件头）。
 *  两个翻页容器的滚动位置由 useSnapPager 各自放回去（坑 62/71）。 */
onActivated(() => {
  void loadNums()
})

onMounted(async () => {
  await loadNums()
  await newBatch()
})
</script>

<template>
  <div class="wb-page home">
    <!-- 小巧 tab 条（胶囊分段控件）：absolute 居中压在状态栏下沿；
         各 tab 页格统一用 padding-top 给它让位 -->
    <div v-if="tabs.length" class="htabs">
      <button
        v-for="(t, i) in tabs"
        :key="t.id"
        class="htab"
        :class="{ on: pane === i }"
        type="button"
        @click="goPane(i)"
      >
        {{ t.label }}<span v-if="t.n" class="htn">{{ t.n }}</span>
      </button>
    </div>

    <!-- 首帧：数量还没数完，先不摆任何 tab（避免落点跳变闪一下） -->
    <div v-if="!tabs.length" class="hboot">
      <van-loading color="#4f46e5" />
    </div>

    <div v-else ref="rootEl" class="hroot" @scroll.passive="onScrollRoot">
      <section v-for="(t, i) in tabs" :key="t.id" class="hpage">
        <!-- 复习 / 学习：整轮训练本体嵌进来（左右滑让位给外层 tab 翻页）；
             不是当前 tab 的那侧不许出声、不许抢焦点、不许亮固定操作条 -->
        <TrainSession v-if="t.id === 'due'" scope="due" embedded :active="pane === i" />
        <TrainSession v-else-if="t.id === 'new'" scope="new" embedded :active="pane === i" />

        <!-- 随便刷：一题一屏（随机） -->
        <div v-else-if="t.id === 'feed'" class="qpane">
          <div class="qtop">
            <span v-if="total" class="qnum">{{ idx + 1 }} / {{ total }}</span>
            <span v-if="done" class="qres">对 {{ right }} · 已答 {{ done }}</span>
            <span class="wb-sp" />
            <button class="qmore" type="button" @click="newBatch">换一批</button>
          </div>

          <van-loading v-if="loading" class="qld" color="#4f46e5">组题…</van-loading>

          <!-- ★ 一题一屏，用**原生吸附滚动**：这一版才是你要的那个滑动效果
               （上一版用 touch 手势直接换内容，没有动画）。

               ★ qscroll 常挂（坑 80）：不许为了 loading 把它 v-else 拆掉 ——
               它是 flex:1 的撑子，一拆底栏「显示选项」就漂到屏幕中部，
               内容到了再跳回底部 = 用户看到的「打开就闪」。loading 只做
               覆盖层，布局从零帧起就是最终形状。 -->
          <div v-show="loading || total > 0" :ref="setQScrollEl" class="qscroll" @scroll.passive="onQScroll">
            <section v-for="(entry, i) in queue" :key="`${serial}-${i}-${entry.kind}`" class="qpage">
              <div class="qpage-in">
                <div class="qcenter">
                  <template v-if="Math.abs(i - idx) <= 3 || (qIntent != null && Math.abs(i - qIntent) <= 3) || Math.abs(i - qVisual) <= 3">
                  <QuestionBox
                  v-if="entry.kind === 'q'"
                  :ref="(el) => setBox(i, el)"
                  hide-result
                  allow-pick
                  :sense-id="entry.senseId"
                  :serial="i"
                  :question="preMade.get(i)"
                  :answered="resultAt[i]"
                  @answered="onAnsweredAt(i, $event)"
                  @state="(st) => onBoxState(i, st)"
                  @loaded="(q) => onLoaded(i, q)"
                    @pick="pick"
                    @word="goWord"
                  >
                    <!-- 改内容按钮放在题目卡片自己的固定底栏里：
                         和「看其它例句」同一块，不跟着题面/例句滚。 -->
                    <template #actions>
                      <div class="qfix">
                        <button class="qfix-b" type="button" @click="openFixAt(i, 'sentence')">改例句</button>
                        <button class="qfix-b" type="button" @click="openFixAt(i, 'sense')">改释义</button>
                        <button
                          v-if="aiOn"
                          class="qfix-b"
                          type="button"
                          :disabled="aiBusy"
                          @click="aiReplaceAt(i)"
                        >
                          {{ aiBusy ? '换句中…' : 'AI 换一句' }}
                        </button>
                      </div>
                    </template>
                  </QuestionBox>
                  <!-- 扫读卡：组队列时已带全数据，没有预取/loaded 那一套；
                       勾叉自评存盘走 scanMarks（窗口卸载再挂回要恢复原样） -->
                  <ScanCard
                    v-else
                    :items="entry.items"
                    :marks="scanMarks.get(i)"
                    @state="(st) => onBoxState(i, st)"
                    @verdict="(v) => onScanVerdict(i, v)"
                    @pick="pick"
                    @word="goWord"
                  />
                  </template>
                </div>
              </div>
            </section>
          </div>

          <div v-if="!loading && !cur" class="qempty">
            <p>这组现在没有可练的</p>
            <div class="qempty-btns">
              <van-button block round type="primary" @click="newBatch">换一批</van-button>
              <van-button v-if="wordsN > 0" block round @click="goTab('new')">去学新词</van-button>
            </div>
          </div>

          <!-- ★ 这里原来有一条固定底栏（我不会 / 显示选项 / 上一题 / 下一题）。
               用户实测后拍板取消：扫读卡没有「上一题」的概念，固定栏对它是
               硬凑的；而且底栏高度切换会改页边界（坑 74）。现在所有动作都
               回到卡片里 —— QuestionBox 自带的「我不会 / 显示选项」就在
               句子下面，作答后用竖滑翻下一张。 -->
        </div>
      </section>
    </div>

    <WordPeek :show="peekOpen" :token="peekToken" :context="curQ?.sentence.en ?? ''" @close="peekOpen = false" />
    <AiSheet
      :show="aiOpen"
      :result="aiResult"
      :busy="aiBusy"
      :error="aiError"
      :label="curQ?.sense.word ?? ''"
      @close="aiOpen = false"
      @applied="onAiApplied"
    />
    <QuickEdit
      :sentence="edSentence"
      :sense="edSense"
      @saved="() => { edSentence = null; edSense = null; }"
    />
  </div>
</template>

<style scoped>
.home {
  position: relative;
  height: calc(100dvh - var(--wb-tabbar-h));
  overflow: hidden;
  background:
    radial-gradient(900px 480px at 12% -8%, #eef2ff 0%, rgba(238, 242, 255, 0) 58%),
    radial-gradient(700px 400px at 100% 4%, #f5f3ff 0%, rgba(245, 243, 255, 0) 55%),
    var(--wb-bg);
  display: flex;
  flex-direction: column;
}

/* 首帧（数量未出）：轻量居中 loading，一瞬即过 */
.hboot {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hroot {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x mandatory;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.hroot::-webkit-scrollbar {
  display: none;
}

.hpage {
  flex: 0 0 100%;
  /* ★ 必须显式 min-width:0。
     flex 项的自动最小尺寸（min-width:auto）会把页格撑到**内容最小宽度**：
     复习/学习页里嵌的 .wb-wrap 有 max-width:680px，页格就被撑成 680 ——
     而容器可视宽只有 360。后果是三个联动故障（真机实测）：
       · 页宽 680 / 步长 360 对不上，scrollLeft 永远落不到页边界（off≥6），
         pager 的 page 不更新 → **顶部 tab 高亮卡在旧值**；
       · 一屏里同时露出前一页的尾巴和后一页的开头 → 看着像**重复视图**；
       · 内容按 680 居中，右半屏被裁掉 → **宽度异常**（句子被切断）。 */
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  /* 统一给顶部 tab 条让位：各 tab 页格自己不再算状态栏，
     内层滚动容器（.tsess / .qpane / .list-wrap）都顶满让位后的剩余高度 */
  padding-top: calc(var(--wb-sb-h) + 42px);
  scroll-snap-align: start;
  scroll-snap-stop: always;
  display: flex;
  flex-direction: column;
}

/* 小巧 tab 条：胶囊分段控件（替代原来的两个圆点指示器）。
   absolute 居中压在状态栏下沿，带半透明底片（压在内容上也不糊）。 */
.htabs {
  position: absolute;
  top: calc(var(--wb-sb-h) + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--wb-line);
  backdrop-filter: blur(6px);
}

.htab {
  border: 0;
  background: transparent;
  border-radius: 999px;
  padding: 4px 11px;
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--wb-ink-2);
  cursor: pointer;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}

.htab.on {
  background: var(--wb-primary);
  color: #fff;
  font-weight: 600;
}

/* tab 名后面的小数字（复习 12 / 学习 8） */
.htn {
  margin-left: 3px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

/* ── 随便刷 ── */
.qpane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 18px 8px;
  overflow: hidden;
}

/* 一题一屏：竖向吸附 + 原生滚动动画 */
.qscroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  margin: 0 -18px;
}

.qscroll::-webkit-scrollbar {
  display: none;
}

.qpage {
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  box-sizing: border-box;
  display: flex;
}

.qtop {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-bottom: 10px;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.qnum,
.qres {
  font-variant-numeric: tabular-nums;
}

.qmore {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--wb-primary);
  padding: 2px;
  cursor: pointer;
}

.qld {
  /* 覆盖层而不是布局参与者（坑 80）：盖在常挂的 .qscroll 上，
     底下的布局从头到尾是最终形状，loading 消失时没有任何东西挪位 */
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--wb-bg);
}

.qempty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  text-align: center;
  font-size: 14px;
  color: var(--wb-ink-2);
}

.qempty-btns {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

/* 改内容：固定在卡片底栏里，不占固定底栏 */
.qfix {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  padding: 8px 0 0;
}

.qfix-b {
  border: 1px dashed var(--wb-line);
  background: transparent;
  border-radius: 10px;
  padding: 6px 10px;
  font-family: inherit;
  font-size: 12px;
  color: var(--wb-ink-2);
  cursor: pointer;
}

.qfix-b:active {
  background: var(--wb-bg);
}

/* 底栏已取消（用户拍板：扫读卡下固定栏是多余的），
   「我不会 / 显示选项」由 QuestionBox 自带、就在卡片里，翻页只走竖滑。 */

.qpage-in {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 18px;
  /* 页面本身不再滚：题面内部滚，卡片底栏和翻页手势才不会打架 */
  overflow: hidden;
}

/* 卡片在这个高度里居中；内容高了就由卡片自己限高、内部滚 */
.qcenter {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
}

/* 题目卡片：独立类名。
   以前 QuestionBox 根节点也叫 .qb，和底栏按钮撞名 —— 子组件根节点会吃到
   父组件的 scoped 样式，于是按钮的 padding / 圆角 / 灰底全漏到了卡片上。
   现在按钮叫 .qbtn，卡片单独命名并明确给白底。 */
.qcard {
  width: 100%;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  padding: 14px 12px;
  box-shadow: 0 1px 2px rgba(31, 35, 51, 0.03);
}

/* 作答后固定占满卡片高度（最大高度），切换题面/其它例句时卡片不跳大小 */
.qcard.qcard-full {
  height: 100%;
}
</style>
