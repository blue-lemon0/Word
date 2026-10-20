<script setup lang="ts">
/** 首页 = **两屏**，左右滑。
 *
 *  屏一「刷」= 练习页的一题一屏：词 + 音标 + 例句 + 四个选项 → 判分 + 解析，
 *          上下滑换下一题。视觉与交互照背单词页（不另造一套）。
 *          出题源两种：**随机**（原「随便练」）与**按计划**（到期 / 新词 / 在学）。
 *  屏二「句子」= 练习页的句子列表（随机），点一行看答案、练这一句。
 *          底部左右两颗按钮：复习（今天剩余）/ 学习（词库），
 *          它们只是把屏一切到对应来源再滑过去 —— 不再跳任何「练习页」。
 *
 *  ★ 本页只管「随机刷 + 扫句子」；「按计划的一整轮」（到期/新词/在学）
 *    在 /train（openPlan 跳过去）。两个入口别混：这里不出现「练法选择」。
 */
import { computed, nextTick, onActivated, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ScanList from '../components/ScanList.vue'
import ScanPeek from '../components/ScanPeek.vue'
import DrillSheet from '../components/DrillSheet.vue'
import WordPeek from '../components/WordPeek.vue'
import QuestionBox from '../components/QuestionBox.vue'
import QuickEdit from '../components/QuickEdit.vue'
import AiSheet from '../components/AiSheet.vue'
import { replaceSentence } from '../ai/actions'
import { aiReady } from '../ai/config'
import { describeAiError, type AiResult } from '../ai/types'
import type { Question } from '../quiz'
import type { Sense, Sentence } from '../types'
import { allProgress } from '../db'
import { buildRandomQueue, makeQuestion, practicePool, type ScanItem } from '../quiz'
import { useSnapPager } from '../scroll-pager'

const router = useRouter()

type Mode = 'random' | 'due' | 'new' | 'learning'

/**
 * 两个数：**今天该复习的词数** 与 **待学的词数**。
 *
 * ★ 它们必须和「点进去那一组」的口径完全一致 —— 数字来自 A、跳转到 B 时，
 *   人看到「21」进去却是空的（这个错踩过）。所以统一按**词**数、按「这个词最紧要
 *   的那个义项的桶」归类，与词库页五个桶同一套口径。
 */
const dueN = ref(0)
const wordsN = ref(0)

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

/* ── 屏一：一题一屏 ── */
/* ★ 屏一就是**随机**，且自成一体：
   它不管到期、不管复习计划，也不和「复习/学习」那一轮共享队列。
   两个按钮进的是背单词页（一整轮、有进度格、能回看跳题）。 */
const mode = ref<Mode>('random')
const queue = ref<string[]>([])
const serial = ref(0)
/* 初始就是 loading（坑 80）：onMounted 必走 setMode，若初始 false，
   首帧 DOM 会先摆出一副「空池」形状再被 loading 顶掉 —— 又是一次闪。 */
const loading = ref(true)
const done = ref(0)
const right = ref(0)

const cur = computed(() => queue.value[idx.value] ?? '')
const total = computed(() => queue.value.length)
const modeText = computed(() => '随机')

/** 当前题的呈现状态（决定底栏显示哪两个按钮） */
const boxState = ref<{ revealed: boolean; submitted: boolean }>({ revealed: false, submitted: false })

/** 竖滑一屏一题：页码即 idx，换页即重置作答状态。
 *  keep-alive 回来的位置恢复在 useSnapPager 里（坑 62/71），页面不手写。 */
const qPager = useSnapPager('y', {
  max: () => total.value - 1,
  onPage: () => {
    boxState.value = { revealed: false, submitted: false }
  },
})
const idx = qPager.page
const qIntent = qPager.intent
const qVisual = qPager.visual
const qscroll = qPager.el
const onQScroll = qPager.onScroll

/* ── 题目预取（坑 78）──
   QuestionBox 自己挂载后才 makeQuestion：快速连翻时每一页都先亮「出题…」
   空壳， IndexedDB 那一跳在真机上足够被眼睛看见。修法照列表的预加载思路：
   外壳提前把前后几页的题出好，子组件拿到现成的直接用。
   键是**队列下标**（不是 senseId）：同一批里同一个义项出现两次也不串。 */
const preMade = reactive(new Map<number, Question>())
const preInflight = new Set<number>()

async function prefetchOne(i: number): Promise<void> {
  const sid = queue.value[i]
  if (!sid || preMade.has(i) || preInflight.has(i)) return
  preInflight.add(i)
  try {
    const q = await makeQuestion(sid)
    // 等题途中用户可能已「换一批」—— 下标对不上就扔掉，别把旧批的题塞进新批
    if (q && queue.value[i] === sid) preMade.set(i, q)
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

async function setMode(_m: Mode = 'random'): Promise<void> {
  mode.value = 'random'
  loading.value = true
  try {
    queue.value = await buildRandomQueue(50)
    preMade.clear()
    /* 第一题**备好再亮屏**：否则用户看到的是「组题… → 出题… → 内容」
       三段跳（坑 78 的另一半 —— 打开 App 那一刻的闪烁）。 */
    await prefetchOne(0)
  } finally {
    loading.value = false
  }
  prefetchAround(0)
  idx.value = 0
  serial.value++
  done.value = 0
  right.value = 0
  resultAt.value = {}
  await nextTick()
  const el = qscroll.value
  if (el) el.scrollTop = 0
}

/** 当前这页题面组件的引用（底栏按钮要指挥它） */
const boxes = new Map<number, { reveal: () => void; save: (r: 'CORRECT' | 'WRONG' | 'PENDING') => void; reload: () => void }>()

function setBox(i: number, el: unknown): void {
  if (el) boxes.set(i, el as never)
  else boxes.delete(i)
}

/** 把「AI 换一句」也搬到屏一：作答后发现这句不好，当场换（和背单词页同一个动作）。
 *  换完重新出这一题 —— 不然解析里还挂着旧例句。 */
const aiOn = aiReady
const aiOpen = ref(false)
const aiBusy = ref(false)
const aiResult = ref<AiResult | null>(null)
const aiError = ref('')

async function aiReplace(): Promise<void> {
  const q = curQ.value
  if (!q) return
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
  boxes.get(idx.value)?.reload()
}

/** 当前题的完整对象（改内容、查词都要用它） */
const curQ = ref<Question | null>(null)
function onLoaded(i: number, q: Question): void {
  // 组件自己出的题（含 AI 换句后的 reload）也回写进预取缓存 ——
  // 不然往回翻时拿到的还是换句之前的那道旧题
  preMade.set(i, q)
  if (i === idx.value) curQ.value = q
}

const edSentence = ref<Sentence | null>(null)
const edSense = ref<Sense | null>(null)

/** 「有问题？改」：和背单词页同一套 QuickEdit，只是入口更轻 */
function openFix(what: 'sentence' | 'sense'): void {
  const q = curQ.value
  if (!q) return
  edSentence.value = what === 'sentence' ? q.sentence : null
  edSense.value = what === 'sense' ? q.sense : null
}

/** 当前题变了就重置作答状态（在 qPager 的 onPage 里），这里只跟着组件回报 */
function onBoxState(i: number, st: { revealed: boolean; submitted: boolean }): void {
  if (i !== idx.value) return
  boxState.value = st
  // 答完之后内容变长：把这一页滚回顶部，别让人一睁眼只看到 ABCD 和解析
  if (st.submitted) {
    void nextTick(() => {
      const page = qscroll.value?.querySelectorAll('.qpage-in')[i] as HTMLElement | undefined
      if (page) page.scrollTop = 0
    })
  }
}

function askReveal(): void {
  boxes.get(idx.value)?.reveal()
}

function askGiveUp(): void {
  boxes.get(idx.value)?.save('PENDING')
}

/** 底栏「下一题」：goBy 基于 intent 累进 —— 连点三下翻三页，
 *  页码等落地才结算（坑 74：动画途中的位置不配改页码）。到底就停 */
function goNext(): void {
  if ((qIntent.value ?? idx.value) >= total.value - 1) return
  qPager.goBy(1)
}

/** 每题只记一次结果（上下滑来回不会重复计数） */
const resultAt = ref<Record<number, 'CORRECT' | 'WRONG' | 'PENDING'>>({})

function onAnsweredAt(i: number, r: 'CORRECT' | 'WRONG' | 'PENDING'): void {
  if (resultAt.value[i]) return
  resultAt.value = { ...resultAt.value, [i]: r }
  done.value++
  if (r === 'CORRECT') right.value++
}

/* ── 屏二：句子列表 ── */
const scanItem = ref<ScanItem | null>(null)
const drillOpen = ref(false)
const drillSense = ref('')
const drillSent = ref<number | undefined>(undefined)

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

/* ── 两屏切换（横滑翻页容器：页码↔滚动同步、keep-alive 恢复都在 useSnapPager 里，坑 62/71）── */
const hPager = useSnapPager('x')
const pane = hPager.page
const rootEl = hPager.el
const goPane = hPager.goTo
const onScrollRoot = hPager.onScroll

/** 复习 / 学习：**进背单词页**（一整轮、有进度格、能回看跳题）；
 *  屏一留给「随便刷」——那里没有进度条，不该承担一轮复习。 */
function openPlan(scope: 'due' | 'new' | 'learning'): void {
  void router.push({ path: '/train', query: { scope } })
}

/** keep-alive 回来：刷新数字。两个翻页容器的滚动位置由 useSnapPager 各自放回去（坑 62/71）。 */
onActivated(() => {
  void loadNums()
})

onMounted(async () => {
  await loadNums()
  await setMode('random')
})
</script>

<template>
  <div class="wb-page home">
    <!-- 两屏指示：竖着两个点 -->
      <!-- 两屏指示：顶部居中，带一个半透明底片（压在吸顶标题上也不会糊） -->
    <div class="dots">
      <button class="dot" :class="{ on: pane === 0 }" type="button" aria-label="刷题" @click="goPane(0)" />
      <button class="dot" :class="{ on: pane === 1 }" type="button" aria-label="句子列表" @click="goPane(1)" />
    </div>

    <div ref="rootEl" class="hroot" @scroll.passive="onScrollRoot">
      <!-- 屏一：一题一屏（照背单词页） -->
      <section class="hpage">
        <div class="qpane">
          <div class="qtop">
            <span class="qmode">{{ modeText }}</span>
            <span v-if="total" class="qnum">{{ idx + 1 }} / {{ total }}</span>
            <span v-if="done" class="qres">对 {{ right }} · 已答 {{ done }}</span>
            <span class="wb-sp" />
            <button class="qmore" type="button" @click="setMode('random')">换一批</button>
          </div>

          <van-loading v-if="loading" class="qld" color="#4f46e5">组题…</van-loading>

          <!-- ★ 一题一屏，用**原生吸附滚动**：这一版才是你要的那个滑动效果
               （上一版用 touch 手势直接换内容，没有动画）。

               ★ qscroll 常挂（坑 80）：不许为了 loading 把它 v-else 拆掉 ——
               它是 flex:1 的撑子，一拆底栏「显示选项」就漂到屏幕中部，
               内容到了再跳回底部 = 用户看到的「打开就闪」。loading 只做
               覆盖层，布局从零帧起就是最终形状。 -->
          <div v-show="loading || total > 0" ref="qscroll" class="qscroll" @scroll.passive="onQScroll">
            <section v-for="(sid, i) in queue" :key="sid + i" class="qpage">
              <div class="qpage-in">
                <div class="qcenter">
                  <QuestionBox
                  v-if="Math.abs(i - idx) <= 3 || (qIntent != null && Math.abs(i - qIntent) <= 3) || Math.abs(i - qVisual) <= 3"
                  :ref="(el) => setBox(i, el)"
                  hide-actions
                  allow-pick
                  :sense-id="sid"
                  :serial="i"
                  :question="preMade.get(i)"
                  @answered="onAnsweredAt(i, $event)"
                  @state="(st) => onBoxState(i, st)"
                  @loaded="(q) => onLoaded(i, q)"
                    @pick="pick"
                    @word="goWord"
                  />
                </div>
              </div>
            </section>
          </div>

          <div v-if="!loading && !cur" class="qempty">
            <p>这组现在没有可练的</p>
            <div class="qempty-btns">
              <van-button block round type="primary" @click="setMode('random')">换一批</van-button>
              <van-button block round @click="openPlan('new')">去学新词</van-button>
            </div>
          </div>

          <!-- 作答后：这一句/这个意思有问题，就地改（和背单词页同一个 QuickEdit）。

               ★ 不许 v-if 拆掉这一行（坑 74 根治的一半）：它是 .qscroll 的兄弟，
               出现/消失会让 .qscroll 高变 41px —— 翻页落定那一帧底栏正好切换，
               容器变高 → snap 页边界整体搬家 → 动画停在已不是 snap 点的旧目标上，
               真机永久卡在两页之间。容器常挂、visibility 切换，高度就恒定了。 -->
          <div class="qfix" :class="{ ghost: !boxState.submitted }">
            <button class="qfix-b" type="button" @click="openFix('sentence')">改例句</button>
            <button class="qfix-b" type="button" @click="openFix('sense')">改释义</button>
            <button v-if="aiOn" class="qfix-b" type="button" :disabled="aiBusy" @click="aiReplace">
              {{ aiBusy ? '换句中…' : 'AI 换一句' }}
            </button>
          </div>

          <!-- ★ 「我不会 / 显示选项 / 下一题」固定在底部：
               它们是指头的主行动，不能跟着一屏一屏滚走。
               loading 期间不显示：和首题内容同一帧出现，避免先弹出来再挪位。 -->
          <div v-if="total && !loading" class="qbar">
            <template v-if="!boxState.revealed && !boxState.submitted">
              <button class="qb" type="button" @click="askGiveUp">我不会</button>
              <button class="qb primary" type="button" @click="askReveal">显示选项</button>
            </template>
            <button v-else-if="boxState.submitted" class="qb primary wide" type="button" @click="goNext">
              {{ idx >= total - 1 ? '练完了' : '下一题' }}
            </button>
          </div>

        </div>
      </section>

      <!-- 屏二：句子列表 + 底部两颗大按钮 -->
      <section class="hpage">
        <div class="list-wrap">
          <ScanList @pick="scanItem = $event" />
        </div>

        <!-- 屏二底部：复习 / 学习 两颗大按钮（拇指区，一左一右） -->
        <div class="pads">
          <button
            class="pad"
            type="button"
            :disabled="dueN === 0"
            :class="{ off: dueN === 0 }"
            @click="dueN && openPlan('due')"
          >
            <b>{{ dueN }}</b>
            <span>{{ dueN ? '复习 · 今天剩余' : '今天没有到期的' }}</span>
          </button>
          <button
            class="pad study"
            type="button"
            :disabled="wordsN === 0"
            :class="{ off: wordsN === 0 }"
            @click="wordsN && openPlan('new')"
          >
            <b>{{ wordsN }}</b>
            <span>{{ wordsN ? '学习 · 待学' : '没有待学的词了' }}</span>
          </button>
        </div>

      </section>
    </div>

    <ScanPeek
      :item="scanItem"
      @word="(w) => { scanItem = null; pick(w) }"
      :total="scanItem?.count ?? 0"
      @close="scanItem = null"
    />
    <WordPeek :show="peekOpen" :token="peekToken" @close="peekOpen = false" />
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
    <DrillSheet
      :open="drillOpen"
      :sense-id="drillSense"
      :sentence-id="drillSent"
      @close="drillOpen = false"
      @word="(w) => { drillOpen = false; goWord(w) }"
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
}

/* 页面：两屏占满剩余高度，底部按钮条固定 */
.home {
  display: flex;
  flex-direction: column;
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
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  display: flex;
  flex-direction: column;
}

/* 指示点：顶部居中 + 背景矩形 */
.dots {
  position: absolute;
  top: calc(var(--wb-sb-h) + 2px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--wb-line);
  backdrop-filter: blur(6px);
}

.dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(17, 17, 27, 0.2);
  cursor: pointer;
}

.dot.on {
  background: var(--wb-primary);
  width: 16px;
  border-radius: 3px;
}

/* ── 屏一 ── */
.qpane {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: calc(var(--wb-sb-h) + 26px) 18px 8px;
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

.qmode {
  color: var(--wb-ink);
  font-weight: 650;
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

/* 改内容：两颗小字按钮，不抢主行动 */
.qfix {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 8px 2px 0;
}

/* 未作答时占位但不可见：保住高度恒定，.qscroll 才不随作答状态伸缩（坑 74） */
.qfix.ghost {
  visibility: hidden;
}

.qfix-b {
  border: 1px dashed var(--wb-line);
  background: transparent;
  border-radius: 10px;
  padding: 6px 10px;
  font-family: inherit;
  font-size: 12px;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.qfix-b:active {
  background: var(--wb-bg);
}

/* 固定底栏：我不会 / 显示选项 / 下一题 */
.qbar {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  padding: 8px 0 4px;
}

.qb {
  flex: 0 0 34%;
  padding: 13px 10px;
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  background: var(--wb-card);
  font-family: inherit;
  font-size: 15px;
  color: var(--wb-ink);
  cursor: pointer;
}

.qb.primary {
  flex: 1;
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  color: #fff;
  font-weight: 600;
}

.qb.wide {
  flex: 1;
}

.qhint {
  flex: 0 0 auto;
  padding-top: 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.qpage-in {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 18px;
  overflow-y: auto;
}

/* ★ 用「自动外边距」居中，而不是 justify-content: center。
   后者在内容比容器高时会把顶部裁掉 —— 答完题解析一长，词和例句就被挤到屏幕外，
   看到的只有 ABCD。auto 外边距的口径是：放得下就居中，放不下就从头开始排。 */
.qcenter {
  width: 100%;
  margin: auto 0;
}

/* ── 屏二 ── */
.list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 14px 10px;
}

/* 屏二底部按钮条 */
.pads {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  padding: 8px 14px calc(8px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to top, var(--wb-bg) 70%, rgba(255, 255, 255, 0));
  backdrop-filter: blur(6px);
}

.pad {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 8px 8px;
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  background: var(--wb-card);
  font-family: inherit;
  cursor: pointer;
}

.pad b {
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.6px;
  color: var(--wb-ink);
  line-height: 1.1;
}

.pad span {
  font-size: 12px;
  color: var(--wb-ink-3);
}

.pad:active {
  background: var(--wb-bg);
}

.pad.off {
  opacity: 0.55;
  cursor: default;
}

.pad.study {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
}

.pad.study b {
  color: #fff;
}

.pad.study span {
  color: rgba(255, 255, 255, 0.85);
}
</style>
