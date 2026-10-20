<script setup lang="ts">
/** 首页 = **两屏**，左右滑。
 *
 *  屏一「刷」= 练习页的一题一屏：词 + 音标 + 例句 + 四个选项 → 判分 + 解析，
 *          上下滑换下一题。视觉与交互照背单词页（不另造一套）。
 *          这里只做**随机**（原「随便练」）；按计划的一整轮在 /train。
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
const queue = ref<string[]>([])
const serial = ref(0)
/* 初始就是 loading（坑 80）：onMounted 必走 newBatch，若初始 false，
   首帧 DOM 会先摆出一副「空池」形状再被 loading 顶掉 —— 又是一次闪。 */
const loading = ref(true)
const done = ref(0)
const right = ref(0)

const cur = computed(() => queue.value[idx.value] ?? '')
const total = computed(() => queue.value.length)

/** 竖滑一屏一题。
 *  keep-alive 回来的位置恢复在 useSnapPager 里（坑 62/71），页面不手写。 */
const qPager = useSnapPager('y', { max: () => total.value - 1 })
const idx = qPager.page
const qIntent = qPager.intent
const qVisual = qPager.visual
const qscroll = qPager.el
const onQScroll = qPager.onScroll

/** 每一页的呈现状态（决定底栏显示哪两个按钮）。
 *
 *  ★ 必须**按页**存，不能只存一份「当前页」：翻回一页已经作答的题时，
 *    子组件不会重新 emit（它还挂着），只存一份就会被翻页逻辑重置成
 *    「未作答」—— 底栏显示「显示选项」，点下去反而把底栏清空。
 *    QuestionBox 每次装载都会报一次状态，所以重挂的页也能对上。
 */
const boxStates = reactive(new Map<number, { revealed: boolean; submitted: boolean }>())
const boxState = computed(
  () => boxStates.get(idx.value) ?? { revealed: false, submitted: false },
)

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

async function newBatch(): Promise<void> {
  loading.value = true
  /* 换一批 = 换一代：键里带 serial，上一批的组件不会被同名键复用，
     避免「同一个义项恰好落在同一个下标」时沿用上一批的作答状态。 */
  serial.value++
  preMade.clear()
  boxStates.clear()
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

function askReveal(): void {
  boxes.get(idx.value)?.reveal()
}

function askGiveUp(): void {
  // 「我不会」按答错处理：诚实放弃不能比乱蒙更划算
  boxes.get(idx.value)?.save('WRONG')
}

/** 底栏「下一题」：goBy 基于 intent 累进 —— 连点三下翻三页，
 *  页码等落地才结算（坑 74：动画途中的位置不配改页码）。到底就停 */
function goNext(): void {
  if ((qIntent.value ?? idx.value) >= total.value - 1) return
  qPager.goBy(1)
}

/** 底栏「上一题」：和背单词页同一个动作。不补这一颗的话，
 *  答完只能往下走，想回头看刚才那句只能靠手势。 */
function goPrev(): void {
  if ((qIntent.value ?? idx.value) <= 0) return
  qPager.goBy(-1)
}

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
  await newBatch()
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
            <span class="qmode">随机</span>
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
          <div v-show="loading || total > 0" ref="qscroll" class="qscroll" @scroll.passive="onQScroll">
            <section v-for="(sid, i) in queue" :key="`${serial}-${sid}-${i}`" class="qpage">
              <div class="qpage-in">
                <div class="qcenter">
                  <QuestionBox
                  v-if="Math.abs(i - idx) <= 3 || (qIntent != null && Math.abs(i - qIntent) <= 3) || Math.abs(i - qVisual) <= 3"
                  :ref="(el) => setBox(i, el)"
                  hide-actions
                  hide-result
                  allow-pick
                  :sense-id="sid"
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
                </div>
              </div>
            </section>
          </div>

          <div v-if="!loading && !cur" class="qempty">
            <p>这组现在没有可练的</p>
            <div class="qempty-btns">
              <van-button block round type="primary" @click="newBatch">换一批</van-button>
              <van-button block round @click="openPlan('new')">去学新词</van-button>
            </div>
          </div>

          <!-- ★ 「我不会 / 显示选项 / 上一题 / 下一题」固定在底部：
               它们是指头的主行动，不能跟着一屏一屏滚走。
               loading 期间不显示：和首题内容同一帧出现，避免先弹出来再挪位。

               ★ 三个分支必须都有内容（对齐背单词页的底栏）：
                 只写「未显示选项」和「已作答」两段，中间那段
                 （选项已展开、还没选）就是一条**空条** —— 用户点了
                 「显示选项」后底栏凭空消失，而且容器高度 63→12px，
                 又一次改变 snap 页边界（坑 74 的同一类病）。 -->
          <div v-if="total && !loading" class="qbar">
            <template v-if="!boxState.revealed && !boxState.submitted">
              <button class="qbtn" type="button" @click="askGiveUp">我不会</button>
              <button class="qbtn primary" type="button" @click="askReveal">显示选项</button>
            </template>
            <template v-else-if="!boxState.submitted">
              <button class="qbtn" type="button" :disabled="idx === 0" @click="goPrev">上一题</button>
              <span class="qpick">点上面四个选项作答</span>
            </template>
            <template v-else>
              <button class="qbtn" type="button" :disabled="idx === 0" @click="goPrev">上一题</button>
              <button
                class="qbtn primary wide"
                type="button"
                :disabled="idx >= total - 1"
                @click="goNext"
              >
                {{ idx >= total - 1 ? '已是最后一题' : '下一题' }}
              </button>
            </template>
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

/* 固定底栏：我不会 / 显示选项 / 上一题 / 下一题。
   ★ 三个分支的高度必须一样（都是同一颗 .qbtn 高 + 同样的 padding），
     否则每次作答/显示选项都会让 .qscroll 的高度跳一次（坑 74）。
   ★ 只保留一行主行动；改内容按钮已经放进解析卡片，底栏不再为空行预留高度。 */
.qbar {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  margin: 0 -18px;
  padding: 8px 18px 4px;
  border-top: 1px solid var(--wb-line);
  background: color-mix(in srgb, var(--wb-bg) 94%, transparent);
}

.qbtn {
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

.qbtn:disabled {
  opacity: 0.45;
  cursor: default;
}

.qbtn.primary {
  flex: 1;
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  color: #fff;
  font-weight: 600;
}

.qbtn.primary:disabled {
  opacity: 0.55;
}

.qbtn.wide {
  flex: 1;
}

/* 选项已展开、等待点选时的说明：占住主按钮的位置，底栏不塌。
   用 ink-2 而不是 ink-3 —— 真机上 ink-3 太浅，看着像禁用提示。 */
.qpick {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--wb-ink-2);
}

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
