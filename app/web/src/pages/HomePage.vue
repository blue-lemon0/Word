<script setup lang="ts">
/** 首页 = **两屏**，左右滑切。
 *
 *  屏一「刷」：模仿短视频 —— 一屏一句，上下滑换句子；视觉照**背单词页**来：
 *    巨号词 + 音标 + 居中例句（目标词高亮）+ 点一下看意思 + 底部两个动作。
 *  屏二「句子」：新闻 app 那样一列句子（随机），底部左右两个大按钮：
 *    左「复习 N」（今天剩余）/ 右「学习 M」（词库词数），点了进背单词页。
 *
 *  ★ 这两个按钮是**唯一的主行动**，放在拇指区，一左一右。
 *  ★ 背单词页本身不改：它才是主场（进度格、回看、跳题、改内容、AI 换句）。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MarkedText from '../components/MarkedText.vue'
import ScanList from '../components/ScanList.vue'
import ScanPeek from '../components/ScanPeek.vue'
import DrillSheet from '../components/DrillSheet.vue'
import WordPeek from '../components/WordPeek.vue'
import { allProgress, allWords, db } from '../db'
import { feedBatch, type ScanItem } from '../quiz'

const router = useRouter()

/* ── 两个数：今天剩余到期 / 词库词数 ── */
const dueN = ref(0)
const wordsN = ref(0)

async function loadNums(): Promise<void> {
  const [prows, wrows] = await Promise.all([allProgress(), allWords()])
  const now = Math.floor(Date.now() / 1000)
  dueN.value = prows.filter((p) => p.reps > 0 && !p.mastered && p.dueAt <= now).length
  wordsN.value = wrows.length
}

/* ── 屏一：刷 ── */
const feed = ref<ScanItem[]>([])
const feedLoading = ref(false)
const feedEl = ref<HTMLElement | null>(null)
const revealed = ref<Set<number>>(new Set())
const ipaMap = ref<Map<string, string>>(new Map())

async function more(n = 8): Promise<void> {
  if (feedLoading.value) return
  feedLoading.value = true
  try {
    const exclude = feed.value.map((it) => it.sense.word)
    const batch = await feedBatch(n, exclude)
    if (batch.length) feed.value = [...feed.value, ...batch]
  } finally {
    feedLoading.value = false
  }
}

async function loadIpa(w: string): Promise<void> {
  if (ipaMap.value.has(w)) return
  const row = await db.words.get(w)
  if (row?.ipa) {
    const m = new Map(ipaMap.value)
    m.set(w, row.ipa)
    ipaMap.value = m
  }
}

const ipaOf = (w: string): string => ipaMap.value.get(w) ?? ''

function onFeedScroll(): void {
  const el = feedEl.value
  if (!el) return
  const i = Math.round(el.scrollTop / (el.clientHeight || 1))
  const it = feed.value[i]
  if (it) void loadIpa(it.sense.word)
  if (!feedLoading.value && i >= feed.value.length - 3) void more(8)
}

function toggleReveal(sid: number): void {
  const s = new Set(revealed.value)
  if (s.has(sid)) s.delete(sid)
  else s.add(sid)
  revealed.value = s
}

/* ── 屏一上的动作：练这一句 / 换一个 ── */
const drillOpen = ref(false)
const drillSense = ref('')
const drillSent = ref<number | undefined>(undefined)

function drillAt(it: ScanItem): void {
  drillSense.value = it.sense.id
  drillSent.value = it.sentence.id
  drillOpen.value = true
}

function nextCard(): void {
  const el = feedEl.value
  if (!el) return
  el.scrollBy({ top: el.clientHeight, behavior: 'smooth' })
}

/* ── 屏二：句子列表 ── */
const scanItem = ref<ScanItem | null>(null)

function onListDrill(it: ScanItem): void {
  scanItem.value = null
  drillSense.value = it.sense.id
  drillSent.value = it.sentence.id
  drillOpen.value = true
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

/* ── 两屏切换：横滑即可，左上两个小点也能点 ── */
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

onMounted(async () => {
  await Promise.all([loadNums(), more(10)])
  const first = feed.value[0]
  if (first) void loadIpa(first.sense.word)
})
</script>

<template>
  <div class="wb-page home">
    <!-- 两屏指示：竖着两个小点，点一下也能切 -->
    <div class="dots">
      <button
        class="dot"
        :class="{ on: pane === 0 }"
        type="button"
        aria-label="刷句子"
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
      <!-- 屏一：刷（视觉照背单词页：巨号词 + 音标 + 居中例句 + 点一下看意思） -->
      <section class="hpage">
        <div ref="feedEl" class="feed" @scroll.passive="onFeedScroll">
          <article v-for="it in feed" :key="it.sentence.id" class="fc">
            <div class="fc-main" @click="toggleReveal(it.sentence.id as number)">
              <div class="fc-word">
                <button class="w" type="button" @click.stop="goWord(it.sense.word)">
                  {{ it.sense.word }}
                </button>
                <span v-if="ipaOf(it.sense.word)" class="ipa">/{{ ipaOf(it.sense.word) }}/</span>
              </div>

              <p class="fc-sn">
                <MarkedText
                  :text="it.sentence.en"
                  :form="it.sentence.form"
                  :span-start="it.sentence.spanStart"
                  :span-len="it.sentence.spanLen"
                  pickable
                  @pick="pick"
                />
              </p>

              <p v-if="!revealed.has(it.sentence.id as number)" class="fc-hint">
                点一下看意思
              </p>
              <div v-else class="fc-ans">
                <p class="fc-g">
                  <span class="fc-pos">{{ it.sense.pos || '—' }}</span>
                  {{ it.sense.gloss || '（这个意思还没有释义）' }}
                </p>
                <p v-if="it.sentence.zh" class="fc-zh">{{ it.sentence.zh }}</p>
                <p v-if="it.sense.note" class="fc-note">{{ it.sense.note }}</p>
              </div>
            </div>

            <div class="fc-bar">
              <button class="bar-btn" type="button" @click.stop="drillAt(it)">练这一句</button>
              <button class="bar-btn ghost" type="button" @click.stop="nextCard">换一个</button>
            </div>
          </article>

          <div v-if="!feed.length" class="fc-empty">
            <van-loading v-if="feedLoading" color="#4f46e5">装卡…</van-loading>
            <template v-else>
              <p>词库里还没有能刷的句子</p>
              <van-button size="small" round type="primary" @click="router.push('/library')">
                去词库
              </van-button>
            </template>
          </div>
        </div>
      </section>

      <!-- 屏二：句子列表（新闻 app 那样一列随机句子）+ 底部两个大按钮 -->
      <section class="hpage">
        <div class="list-wrap">
          <ScanList @pick="scanItem = $event" />
        </div>

        <div class="pads">
          <button class="pad" type="button" @click="router.push('/train?scope=due')">
            <b>{{ dueN }}</b>
            <span>复习 · 今天剩余</span>
          </button>
          <button class="pad study" type="button" @click="router.push('/train?scope=new')">
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

/* 两屏：横向吸附 */
.hroot {
  display: flex;
  height: 100%;
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
  position: relative;
  display: flex;
  flex-direction: column;
}

/* 顶部指示点（竖排，避开手势区） */
.dots {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  display: flex;
  flex-direction: column;
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

/* ── 屏一：刷 ── */
.feed {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-snap-type: y mandatory;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}

.feed::-webkit-scrollbar {
  display: none;
}

.fc {
  height: 100%;
  scroll-snap-align: start;
  scroll-snap-stop: always;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: calc(var(--wb-sb-h) + 22px) 22px calc(14px + env(safe-area-inset-bottom, 0px));
}

.fc-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  overflow-y: auto;
}

/* 和背单词页同一套字阶：词最大、音标小、例句居中 */
.fc-word {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.w {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 38px;
  font-weight: 750;
  letter-spacing: -1px;
  line-height: 1.15;
  color: var(--wb-ink);
  padding: 0;
  cursor: pointer;
}

.ipa {
  font-size: 13px;
  color: var(--wb-ink-3);
}

.fc-sn {
  margin-top: 18px;
  font-size: 19px;
  line-height: 1.7;
  text-align: center;
  color: var(--wb-ink);
}

.fc-hint {
  margin-top: 22px;
  text-align: center;
  font-size: 13px;
  color: var(--wb-ink-3);
}

.fc-ans {
  margin-top: 18px;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 14px;
  padding: 12px 14px;
}

.fc-g {
  font-size: 16px;
  line-height: 1.55;
  color: var(--wb-ink);
}

.fc-pos {
  font-size: 11.5px;
  color: var(--wb-ink-3);
  margin-right: 6px;
}

.fc-zh {
  margin-top: 7px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.fc-note {
  margin-top: 5px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}

/* 底部两个动作：和背单词页底条同一位置感 */
.fc-bar {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  padding-top: 14px;
}

.bar-btn {
  flex: 1;
  padding: 12px 10px;
  border: 0;
  border-radius: 14px;
  background: var(--wb-primary);
  color: #fff;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.bar-btn.ghost {
  flex: 0 0 34%;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  color: var(--wb-ink);
  font-weight: 500;
}

.fc-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 14px;
  color: var(--wb-ink-2);
}

/* ── 屏二：句子列表 + 底部两个大按钮 ── */
.list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 只留一点让位：这一屏的主体是列表，不要被顶部空白吃掉一屏的 1/6 */
  padding: calc(var(--wb-sb-h) + 6px) 14px 8px;
}

.pads {
  flex: 0 0 auto;
  display: flex;
  gap: 10px;
  padding: 10px 14px calc(12px + env(safe-area-inset-bottom, 0px));
}

.pad {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 12px 8px;
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  background: var(--wb-card);
  font-family: inherit;
  cursor: pointer;
}

.pad b {
  font-size: 26px;
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
