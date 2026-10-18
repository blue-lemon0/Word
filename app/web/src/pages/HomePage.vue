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
 *  ★ 所以 `/train` 那一页删了：它的两种形态就是这两屏。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ScanList from '../components/ScanList.vue'
import ScanPeek from '../components/ScanPeek.vue'
import DrillSheet from '../components/DrillSheet.vue'
import WordPeek from '../components/WordPeek.vue'
import QuestionBox from '../components/QuestionBox.vue'
import { allProgress, allWords } from '../db'
import { buildQueue, buildRandomQueue, buildScopeQueue, type ScanItem } from '../quiz'

const router = useRouter()
const route = useRoute()

type Mode = 'random' | 'due' | 'new' | 'learning'

/* ── 两个数：今天剩余到期 / 词库词数 ── */
const dueN = ref(0)
const wordsN = ref(0)

async function loadNums(): Promise<void> {
  const [prows, wrows] = await Promise.all([allProgress(), allWords()])
  const now = Math.floor(Date.now() / 1000)
  dueN.value = prows.filter((p) => p.reps > 0 && !p.mastered && p.dueAt <= now).length
  wordsN.value = wrows.length
}

/* ── 屏一：一题一屏 ── */
const mode = ref<Mode>('random')
const queue = ref<string[]>([])
const idx = ref(0)
const serial = ref(0)
const loading = ref(false)
const done = ref(0)
const right = ref(0)

const cur = computed(() => queue.value[idx.value] ?? '')
const total = computed(() => queue.value.length)
const modeText = computed(() =>
  mode.value === 'random'
    ? '随便练'
    : mode.value === 'due'
      ? '今天到期'
      : mode.value === 'new'
        ? '学新词'
        : '在学',
)

async function setMode(m: Mode): Promise<void> {
  mode.value = m
  loading.value = true
  try {
    if (m === 'random') queue.value = await buildRandomQueue(50)
    else if (m === 'due') {
      queue.value = await buildScopeQueue('due', 20)
      if (!queue.value.length) queue.value = await buildQueue(20)
    } else queue.value = await buildScopeQueue(m, 20)
  } finally {
    loading.value = false
  }
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
const boxes = new Map<number, { reveal: () => void; save: (r: 'CORRECT' | 'WRONG' | 'PENDING') => void }>()

function setBox(i: number, el: unknown): void {
  if (el) boxes.set(i, el as never)
  else boxes.delete(i)
}

/** 当前题的呈现状态（决定底栏显示哪两个按钮） */
const boxState = ref<{ revealed: boolean; submitted: boolean }>({ revealed: false, submitted: false })

function onBoxState(i: number, st: { revealed: boolean; submitted: boolean }): void {
  if (i === idx.value) boxState.value = st
}

function askReveal(): void {
  boxes.get(idx.value)?.reveal()
}

function askGiveUp(): void {
  boxes.get(idx.value)?.save('PENDING')
}

/** 底栏「下一题」：滚到下一页（原生吸附给动画），到底就停 */
function goNext(): void {
  const el = qscroll.value
  if (!el) return
  if (idx.value >= total.value - 1) return
  el.scrollBy({ top: el.clientHeight, behavior: 'smooth' })
}

/** 滚动到第几题（原生吸附负责动画，这里只同步「第 n / m 题」与统计） */
const qscroll = ref<HTMLElement | null>(null)

function onQScroll(): void {
  const el = qscroll.value
  if (!el) return
  const i = Math.round(el.scrollTop / (el.clientHeight || 1))
  if (i !== idx.value) {
    idx.value = Math.min(Math.max(i, 0), Math.max(total.value - 1, 0))
    boxState.value = { revealed: false, submitted: false }
  }
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

function onListDrill(it: ScanItem): void {
  scanItem.value = null
  drillSense.value = it.sense.id
  drillSent.value = it.sentence.id
  drillOpen.value = true
}

/* ── 查词浮层 / 跳转 ── */
const peekOpen = ref(false)
const peekToken = ref('')

function goWord(w: string): void {
  void router.push(`/word/${encodeURIComponent(w)}`)
}

/* ── 两屏切换 ── */
const pane = ref(0)
const rootEl = ref<HTMLElement | null>(null)

function toPane(i: number): void {
  const el = rootEl.value
  if (!el) return
  el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' })
}

function onScrollRoot(): void {
  const el = rootEl.value
  if (!el) return
  pane.value = Math.round(el.scrollLeft / (el.clientWidth || 1))
}

async function openPlan(scope: 'due' | 'new' | 'learning'): Promise<void> {
  await setMode(scope)
  toPane(0)
}

onMounted(async () => {
  await loadNums()
  await setMode('random')
  const p = route.query.practice
  if (p === 'due' || p === 'new' || p === 'learning') {
    await setMode(p)
    toPane(0)
  }
})
</script>

<template>
  <div class="wb-page home">
    <!-- 两屏指示：竖着两个点 -->
    <div class="dots">
      <button
        class="dot"
        :class="{ on: pane === 0 }"
        type="button"
        aria-label="刷题"
        @click="toPane(0)"
      />
      <button
        class="dot"
        :class="{ on: pane === 1 }"
        type="button"
        aria-label="句子列表"
        @click="toPane(1)"
      />
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
               （上一版用 touch 手势直接换内容，没有动画）。 -->
          <div v-else ref="qscroll" class="qscroll" @scroll.passive="onQScroll">
            <section v-for="(sid, i) in queue" :key="sid + i" class="qpage">
              <div class="qpage-in">
                <QuestionBox
                  v-if="Math.abs(i - idx) <= 1"
                  :ref="(el) => setBox(i, el)"
                  hide-actions
                  :sense-id="sid"
                  :serial="i"
                  @answered="onAnsweredAt(i, $event)"
                  @state="(st) => onBoxState(i, st)"
                  @word="goWord"
                />
              </div>
            </section>
          </div>

          <div v-if="!loading && !cur" class="qempty">
            <p>这组现在没有可练的</p>
            <div class="qempty-btns">
              <van-button block round type="primary" @click="setMode('random')">随便练</van-button>
              <van-button block round @click="openPlan('new')">学新词</van-button>
            </div>
          </div>

          <!-- ★ 「我不会 / 显示选项 / 下一题」固定在底部：
               它们是指头的主行动，不能跟着一屏一屏滚走。 -->
          <div v-if="total" class="qbar">
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
          <button class="pad" type="button" @click="openPlan('due')">
            <b>{{ dueN }}</b>
            <span>复习 · 今天剩余</span>
          </button>
          <button class="pad study" type="button" @click="openPlan('new')">
            <b>{{ wordsN }}</b>
            <span>学习 · 词库</span>
          </button>
        </div>

      </section>
    </div>

    <ScanPeek
      :item="scanItem"
      :total="scanItem?.count ?? 0"
      @close="scanItem = null"
      @drill="onListDrill"
    />
    <WordPeek :show="peekOpen" :token="peekToken" @close="peekOpen = false" />
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

/* 指示点：**放在顶部居中**。
   ★ 别放左侧 —— 竖排的点紧挨着内容，会让人以为它和「上下滑」有关系；
     放在顶上横排，读起来就是「有两屏，左右滑」。 */
.dots {
  position: absolute;
  top: calc(var(--wb-sb-h) + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  gap: 6px;
}

.dot {
  width: 6px;
  height: 6px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(17, 17, 27, 0.18);
  cursor: pointer;
}

.dot.on {
  background: var(--wb-primary);
  height: 16px;
  border-radius: 3px;
}

/* ── 屏一 ── */
.qpane {
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
  padding: 30px 0;
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
  justify-content: center;
  padding: 0 18px;
  overflow-y: auto;
}

/* ── 屏二 ── */
.list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: calc(var(--wb-sb-h) + 18px) 14px 10px;
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
