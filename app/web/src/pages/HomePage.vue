<script setup lang="ts">
/** 首页 = **一屏能看全今天**（电商式信息流，不是一张海报）。
 *
 *  ★ 为什么改成信息流：这一页之前只放一张卡，等于「打开 app 只看到一件事」。
 *    真实的使用是碎片的：今天有 12 题要复习、有 14 个新词没碰、有 3 条错题、
 *    还有一堆词在学。这些如果都要「先进训练页 → 再选练法」才能看到，
 *    那首页就永远只是个入口，而不是「今天该干什么」的答案。
 *
 *  ★ 所以这一页的结构照搬电商首页：**一块一块，每块都通向一个具体的动作**。
 *    · 顶部一行动态：今天到期 / 在学 / 待学 / 错题；
 *    · 一排横滑的「快捷卡」：复习、学新词、错题、排进明天的 —— 点哪张练哪个；
 *    · 中间「随手背一句」：能当场看意思，也能「练这一句」；
 *    · 下面「最近在练」：把自己正在学的词摆出来，点了进词条；
 *    · 底部入口：词库、更多。
 *    层层都浅：任何一块点进去都只深一层，返回一下就回来。
 *
 *  ★ 首帧同步取（randomCardNow / loadStatsNow）：`undefined` = 还在读库（给骨架），
 *    `null` = 确实没有（给空态）。两者必须分开 —— 数据没到就说「没有」
 *    是在说用户的词库没了（坑 32）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import InstallPrompt from '../components/InstallPrompt.vue'
import MarkedText from '../components/MarkedText.vue'
import WordPeek from '../components/WordPeek.vue'
import DrillSheet from '../components/DrillSheet.vue'
import QuestionBox from '../components/QuestionBox.vue'
import { buildScopeQueue } from '../quiz'
import {
  loadStats,
  loadStatsNow,
  randomCardNow,
  randomCardWithSentence,
  type Card,
  type Stats,
} from '../composables'
import { allProgress, allSenses, db } from '../db'
import { listFlags } from '../flags'
import type { Sense } from '../types'

const router = useRouter()

const card = ref<Card | null | undefined>(randomCardNow())
const stats = ref<Stats | undefined>(loadStatsNow())

/* ── 这一屏的「今天」数字（全部按**词**数，口径与词库页一致）── */
const dueN = ref(0)
const learningN = ref(0)
const freshN = ref(0)
const flagN = ref(0)

/* ── 副页：在学 / 待学 的词表（和词库的五个桶同一套口径）── */
interface WordMeta {
  word: string
  gloss: string
  done: number
  total: number
}

/* 今天练过几个意思 —— 和「有没有到期」是两件事 */
const todayN = ref(0)

const learningWords = ref<WordMeta[]>([])
const freshWords = ref<WordMeta[]>([])
const tab = ref(0)

async function loadToday(): Promise<void> {
  const [senses, prows, flags] = await Promise.all([allSenses(), allProgress(), listFlags()])
  const pmap = new Map(prows.map((p) => [p.senseId, p]))
  const now = Math.floor(Date.now() / 1000)
  /* ★ 按**词**数，不按义项数 —— 和词库页的五个桶同一套口径。
     混着数会让首页说「72 待学」而词库说「14 待学」，同一件事两个数字，
     用户第一反应是「哪个是真的」。（一个词有多个义项，按最紧要的那个算。） */
  const rankOf = (senseId: string): number => {
    const p = pmap.get(senseId)
    if (!p || p.reps === 0) return 2 // 待学
    if (p.mastered && !p.rusty) return 3 // 已掌握
    if (p.dueAt <= now) return 0 // 到期
    return 1 // 在学
  }
  const buckets = new Map<string, number>() // word -> 最紧要的桶
  for (const s of senses) {
    const r = rankOf(s.id)
    const cur = buckets.get(s.word)
    if (cur === undefined || r < cur) buckets.set(s.word, r)
  }
  let due = 0
  let learn = 0
  let fresh = 0
  for (const r of buckets.values()) {
    if (r === 0) due++
    else if (r === 1) learn++
    else if (r === 2) fresh++
  }
  // 今天练过的意思：progress.lastReview 落在今天 0 点之后
  const t0 = new Date()
  t0.setHours(0, 0, 0, 0)
  const dayStart = Math.floor(t0.getTime() / 1000)
  todayN.value = prows.filter((p) => (p.lastReview ?? 0) >= dayStart).length

  dueN.value = due
  learningN.value = learn
  freshN.value = fresh
  flagN.value = flags.length

  // 副页的词表：每个词一行（释义取它的第一个义项，练过几个意思也标出来）
  const meta = new Map<string, WordMeta>()
  for (const s of senses) {
    const m = meta.get(s.word) ?? { word: s.word, gloss: s.gloss || '', done: 0, total: 0 }
    m.total++
    if ((pmap.get(s.id)?.reps ?? 0) > 0) m.done++
    if (!m.gloss && s.gloss) m.gloss = s.gloss
    meta.set(s.word, m)
  }
  const pick = (rank: number): WordMeta[] =>
    [...buckets.entries()]
      .filter(([, r]) => r === rank)
      .map(([w]) => meta.get(w))
      .filter((m): m is WordMeta => !!m)
      .sort((a, b) => a.word.localeCompare(b.word))
      .slice(0, 60)
  learningWords.value = pick(1)
  freshWords.value = pick(2)
}

/* ── 最近在练：按上次复习时间倒序取三个词 ── */
interface Recent {
  word: string
  gloss: string
  when: number
}

const recent = ref<Recent[]>([])

async function loadRecent(): Promise<void> {
  const [prows, senses] = await Promise.all([allProgress(), allSenses()])
  const byId = new Map<string, Sense>(senses.map((s) => [s.id, s]))
  const rows = prows
    .filter((p) => p.reps > 0 && p.lastReview)
    .sort((a, b) => (b.lastReview ?? 0) - (a.lastReview ?? 0))
  const seen = new Set<string>()
  const out: Recent[] = []
  for (const p of rows) {
    const s = byId.get(p.senseId)
    if (!s || seen.has(s.word)) continue
    seen.add(s.word)
    out.push({ word: s.word, gloss: s.gloss, when: p.lastReview ?? 0 })
    if (out.length >= 3) break
  }
  recent.value = out
}

/* ── 看没看答案 ── */
const revealed = ref(false)
const sense = ref<Sense | null>(null)
const peekOpen = ref(false)
const peekToken = ref('')

async function doReveal(): Promise<void> {
  if (revealed.value) return
  const c = card.value
  if (!c) return
  sense.value = (await db.senses.get(c.senseId)) ?? null
  revealed.value = true
}

async function roll(): Promise<void> {
  card.value = await randomCardWithSentence()
  revealed.value = false
  sense.value = null
  stats.value = await loadStats()
}

function drill(): void {
  const c = card.value
  if (!c) return
  // ★ 浮层，不跳页（D46）：练一句不该把这一屏顶掉，关掉就还在原地。
  drillSense.value = c.senseId
  drillSent.value = c.sentence.id
  drillOpen.value = true
}

/* ── 练这一句的浮层 ── */
const drillOpen = ref(false)
const drillSense = ref('')
const drillSent = ref<number | undefined>(undefined)

function pick(word: string): void {
  if (card.value && word === card.value.word.toLowerCase()) return
  peekToken.value = word
  peekOpen.value = true
}

function fmtWhen(ts: number): string {
  if (!ts) return ''
  const mins = Math.round((Date.now() / 1000 - ts) / 60)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** 快捷卡：**点「练」的卡不跳页，直接切到练习副页开练**（D47）。
 *  错题那张是个例外 —— 错题板本身是一页（列表 + 单挑），没有对应副页。 */
interface Quick {
  key: string
  n: number
  title: string
  sub: string
  /** 有 scope = 在首页的练习副页里练；没有 = 跳去某个页面 */
  scope?: 'due' | 'new' | 'learning'
  to?: string
  tone: 'hot' | 'cool' | 'warn' | 'ink'
}

const quicks = computed<Quick[]>(() => {
  const all: Quick[] = [
    { key: 'due', n: dueN.value, title: '今天复习', sub: '到期就练', scope: 'due', tone: 'hot' },
    { key: 'new', n: freshN.value, title: '学新词', sub: '一次都没练过', scope: 'new', tone: 'cool' },
    { key: 'flag', n: flagN.value, title: '错题', sub: '标记过的句子', to: '/board', tone: 'warn' },
    { key: 'learn', n: learningN.value, title: '在学', sub: '再刷一遍', scope: 'learning', tone: 'ink' },
  ]
  return all.filter((q) => q.n > 0)
})

function onQuick(q: Quick): void {
  if (q.scope) {
    void startPractice(q.scope)
    return
  }
  if (q.to) go(q.to)
}

/* ── 练习副页（第四个 tab）──
 *
 *  ★ 这是「练习成为首页副页」的落点（D47）：快捷卡不再跳 /train，
 *    而是把队列就地装进这个副页 —— 一次都不离开首页。
 *  ★ 队列仍然走 buildScopeQueue（和词库「练这组」同一条口径），
 *    判分走 QuestionBox（和浮层、训练页同一份实现）。
 */
const P_TAB = 3
const pScope = ref<'due' | 'new' | 'learning'>('due')
const pQueue = ref<string[]>([])
const pIdx = ref(0)
const pSerial = ref(0)
const pDone = ref(0)
const pRight = ref(0)
const pLoading = ref(false)
const pCur = computed(() => pQueue.value[pIdx.value] ?? '')
const pTotal = computed(() => pQueue.value.length)

const pScopeText = computed(() =>
  pScope.value === 'due' ? '今天到期' : pScope.value === 'new' ? '新词' : '在学',
)

async function startPractice(s: 'due' | 'new' | 'learning'): Promise<void> {
  pScope.value = s
  tab.value = P_TAB
  pLoading.value = true
  try {
    pQueue.value = await buildScopeQueue(s, 20)
  } finally {
    pLoading.value = false
  }
  pIdx.value = 0
  pSerial.value++
  pDone.value = 0
  pRight.value = 0
}

function pNext(): void {
  if (pIdx.value < pQueue.value.length - 1) {
    pIdx.value++
    pSerial.value++
  } else {
    pQueue.value = []
    pIdx.value = 0
  }
}

function onAnswered(r: 'CORRECT' | 'WRONG' | 'PENDING'): void {
  pDone.value++
  if (r === 'CORRECT') pRight.value++
}

function go(to: string): void {
  router.push(to)
}

/** 进某个词的词条页（练习副页里点词名用） */
function goWord(w: string): void {
  void router.push(/word/ + encodeURIComponent(w))
}

/* ── 整页横滑切副页 ──
 *  ★ 不能只靠 van-tabs 的 swipeable：副页里是长列表，纵向滚动会吃掉横向手势，
 *    于是「下半部分滑不动」。在页面根节点上自己判一次：
 *    横向位移 > 60px 且明显大于纵向，才切页；其余一律放行给滚动。 */
const TAB_N = 4
let sx = 0
let sy = 0

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0]
  sx = t.clientX
  sy = t.clientY
}

function onTouchEnd(e: TouchEvent): void {
  const t = e.changedTouches[0]
  const dx = t.clientX - sx
  const dy = t.clientY - sy
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6) return
  if (dx < 0 && tab.value < TAB_N - 1) tab.value++
  else if (dx > 0 && tab.value > 0) tab.value--
}

onMounted(async () => {
  if (card.value === undefined) await roll()
  await Promise.all([loadToday(), loadRecent()])
})
</script>

<template>
  <div class="wb-page home" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
    <!-- ★ 首页内部再分「副页」：横向滑动切换（D46）。
         你原话是「淘宝底部三个 tab，首页那个 tab 里面还能左右滑」——
         道理是：一屏给不了四种状态，但**滑一下**就能。
         三页分别是：今天（信息流）/ 在学 / 待学。都用同一套口径，滑过去就换一批词。 -->
    <van-tabs
      v-model:active="tab"
      class="htabs"
      swipeable
      sticky
      offset-top="0"
      :animated="false"
      title-active-color="#4f46e5"
      title-inactive-color="#8b8b9a"
      color="#4f46e5"
      line-width="22"
    >
      <van-tab title="今天">
        <div class="wb-wrap">
          <InstallPrompt />

          <!-- 一行「今天」：只留**需要现在动手**的两个数。
               「在学/待学」已经写在下面的快捷卡上，这里再说一遍就是重复；
               底栏已经有「词库 / 更多」，底部再摆一排入口也是重复。 -->
          <!-- ★ 「今天练了没有」和「有没有到期」是两件事，必须分开写。
               原来只说「没有到期的」，人刚练完十几个，读到这句会以为白练了。 -->
          <div class="todayline">
            <span class="t-d">今天</span>
            <span v-if="todayN" class="t-i ok"><b>{{ todayN }}</b> 个意思练过</span>
            <span v-else class="t-i quiet">还没开始练</span>
            <span v-if="dueN" class="t-i hot"><b>{{ dueN }}</b> 个词到期</span>
            <span v-if="flagN" class="t-i warn"><b>{{ flagN }}</b> 条错题</span>
            <span v-if="!todayN && !dueN && !flagN" class="t-i quiet">随手背两句也行</span>
          </div>

          <!-- 快捷卡：横滑，每张通向一个具体动作 -->
          <div v-if="quicks.length" class="row-cards">
            <button
              v-for="q in quicks"
              :key="q.key"
              class="qc"
              :class="q.tone"
              type="button"
              @click="onQuick(q)"
            >
              <b>{{ q.n }}</b>
              <span class="qc-t">{{ q.title }}</span>
              <span class="qc-s">{{ q.sub }}</span>
            </button>
          </div>

          <!-- 随手背一句 -->
          <section class="sect">
            <header class="s-h">
              <b>随手背一句</b>
            </header>

            <div v-if="card" class="bcard">
              <!-- 词在前、句在后：这是一张卡片的读法（先看见要背的词，再看它怎么用）。
                   反过来读像一道「猜词题」，而这一屏是「随手背」。 -->
              <div class="wrow">
                <button
                  class="w"
                  type="button"
                  @click="go(`/word/${encodeURIComponent(card.word)}`)"
                >
                  {{ card.word }}
                </button>
                <span v-if="card.ipa" class="ipa">/{{ card.ipa }}/</span>
              </div>
              <p class="sn">
                <MarkedText
                  :text="card.sentence.en"
                  :form="card.sentence.form"
                  :span-start="card.sentence.spanStart"
                  :span-len="card.sentence.spanLen"
                  pickable
                  @pick="pick"
                />
              </p>

              <button v-if="!revealed" class="reveal" type="button" @click="doReveal">
                点一下看意思
              </button>
              <div v-else class="ans">
                <p class="g">
                  <span class="pos">{{ sense?.pos || '—' }}</span>
                  <span class="gt">{{ sense?.gloss || '（这个意思还没有释义）' }}</span>
                </p>
                <p v-if="card.sentence.zh" class="zh">{{ card.sentence.zh }}</p>
                <p v-if="sense?.note" class="note">{{ sense.note }}</p>
              </div>

              <div class="bacts">
                <van-button size="small" plain @click="roll">换一个</van-button>
                <van-button size="small" type="primary" @click="drill">练这一句</van-button>
              </div>
            </div>

            <div v-else-if="card === undefined" class="bcard skel">
              <div class="l w90" />
              <div class="l w60" />
            </div>
            <div v-else class="bcard">
              <p class="empty">词库还是空的</p>
              <p class="tap">先去词库导入一份词库</p>
            </div>
          </section>

          <!-- 最近在练：条目本身可点进词条；不再挂「词库 ›」——
               底栏就有「词库」，那是同一个去处的第二个入口。 -->
          <section v-if="recent.length" class="sect">
            <header class="s-h">
              <b>最近在练</b>
            </header>
            <button
              v-for="r in recent"
              :key="r.word"
              class="rrow"
              type="button"
              @click="go(`/word/${encodeURIComponent(r.word)}`)"
            >
              <span class="rw">{{ r.word }}</span>
              <span class="rg">{{ r.gloss }}</span>
              <span class="rt">{{ fmtWhen(r.when) }}</span>
            </button>
          </section>

          <!-- 兜底入口：快捷卡一张都没有时（全库都掌握了之类），至少给一条去训练的路。 -->
          <div v-if="!quicks.length" class="fallback">
            <van-button block round @click="go('/train')">去训练</van-button>
          </div>
        </div>
      </van-tab>

      <!-- 副页二：在学（练过、没掌握） -->
      <van-tab :title="`在学 ${learningN}`">
        <div class="wb-wrap">
          <div class="sub-h">
            <b>在学 {{ learningN }}</b>
            <span class="sub-s">练过、还没掌握</span>
            <span class="wb-sp" />
            <van-button
              v-if="learningN"
              size="mini"
              type="primary"
              plain
              @click="go('/train?scope=learning')"
            >
              练这组
            </van-button>
          </div>
          <button
            v-for="w in learningWords"
            :key="w.word"
            class="rrow"
            type="button"
            @click="go(`/word/${encodeURIComponent(w.word)}`)"
          >
            <span class="rw">{{ w.word }}</span>
            <span class="rg">{{ w.gloss }}</span>
            <span class="rt">{{ w.done }}/{{ w.total }}</span>
          </button>
          <van-empty v-if="!learningWords.length" description="还没有在学的词" />
        </div>
      </van-tab>

      <!-- 副页三：待学（一次都没练过） -->
      <van-tab :title="`待学 ${freshN}`">
        <div class="wb-wrap">
          <div class="sub-h">
            <b>待学 {{ freshN }}</b>
            <span class="sub-s">一次都没练过</span>
            <span class="wb-sp" />
            <van-button
              v-if="freshN"
              size="mini"
              type="primary"
              plain
              @click="go('/train?scope=new')"
            >
              学几个
            </van-button>
          </div>
          <button
            v-for="w in freshWords"
            :key="w.word"
            class="rrow"
            type="button"
            @click="go(`/word/${encodeURIComponent(w.word)}`)"
          >
            <span class="rw">{{ w.word }}</span>
            <span class="rg">{{ w.gloss }}</span>
            <span class="rt">{{ w.total }} 句</span>
          </button>
          <van-empty v-if="!freshWords.length" description="待学的词都练过了" />
        </div>
      </van-tab>
      <!-- 副页四：练 —— 就地练，不跳页（D47） -->
      <van-tab :title="pTotal ? `练 ` : '练'">
        <div class="wb-wrap">
          <div class="sub-h">
            <b>练 · {{ pScopeText }}</b>
            <span v-if="pDone" class="sub-s">已答 {{ pDone }} · 对 {{ pRight }}</span>
            <span class="wb-sp" />
            <van-button v-if="!pCur && pDone" size="mini" plain type="primary" @click="startPractice(pScope)">
              再来一组
            </van-button>
          </div>

          <van-loading v-if="pLoading" class="p-ld" color="#4f46e5">组题…</van-loading>

          <template v-else-if="pCur">
            <QuestionBox
              :sense-id="pCur"
              :serial="pSerial"
              @answered="onAnswered"
              @word="goWord"
            >
              <template #after>
                <div class="pacts">
                  <van-button type="primary" block round @click="pNext">
                    {{ pIdx + 1 < pTotal ? '下一题' : '练完了' }}
                  </van-button>
                </div>
              </template>
            </QuestionBox>
          </template>

          <template v-else>
            <p class="p-empty">
              {{ pDone ? `这一组练完了  个，对了  个` : '这组现在没有可练的' }}
            </p>
            <div class="p-choose">
              <van-button block round @click="startPractice('new')">学新词</van-button>
              <van-button block round @click="startPractice('learning')">在学的再刷</van-button>
            </div>
          </template>
        </div>
      </van-tab>

    </van-tabs>

    <WordPeek :show="peekOpen" :token="peekToken" @close="peekOpen = false" />
    <DrillSheet
      :open="drillOpen"
      :sense-id="drillSense"
      :sentence-id="drillSent"
      @close="drillOpen = false"
      @word="(w) => { drillOpen = false; go(`/word/${encodeURIComponent(w)}`) }"
    />
  </div>
</template>

<style scoped>
.home {
  min-height: calc(100dvh - var(--wb-tabbar-h));
  overflow-x: clip;
  background:
    radial-gradient(1200px 600px at 10% -10%, #eef2ff 0%, rgba(238, 242, 255, 0) 60%),
    radial-gradient(900px 500px at 100% 0%, #f5f3ff 0%, rgba(245, 243, 255, 0) 55%),
    var(--wb-bg);
}

/* 顶部让位交给 van-tabs 自己的 sticky 条（它有 safe-area），
   这里只留左右与底部；底部要让出 tabbar */
.wb-wrap {
  padding-top: 8px;
  padding-bottom: calc(14px + var(--wb-tabbar-h));
}

/* 首页内部的副页标签：贴在状态栏下面，白底 + 细线 */
.htabs :deep(.van-tabs__wrap) {
  /* 和 .wb-topbar 同一套让位（--wb-sb-h = max(safe-area, 24px)）：
     这里用 env() 直接写会在没有 viewport-fit 的环境里得到 0，标签就钻到状态栏底下。
     ★ 再多给 10px：标签贴着状态栏时，手指点在字的上一半就会碰到系统手势区
       —— 「太贴、容易误触」不是审美问题，是热区问题。 */
  padding-top: calc(var(--wb-sb-h) + 10px);
  /* Vant 给 .van-tabs__wrap 写死了 44px 高 —— 加 padding 会把标签挤出盒子裁掉。
     必须 height: auto，不然标签就藏在状态栏底下只露出半行。 */
  height: auto;
  /* 标签本身也加高到 48px：一行三个 tab，点起来要稳 */
  --van-tabs-line-height: 48px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--wb-line);
  box-shadow: 0 1px 0 rgba(17, 17, 27, 0.03);
}

.htabs :deep(.van-tab) {
  font-size: 14.5px;
}

.htabs :deep(.van-tab--active) {
  font-weight: 650;
}

.htabs :deep(.van-tabs__nav) {
  background: transparent;
}

.htabs :deep(.van-tabs__line) {
  border-radius: 2px;
}

/* 副页的小标题行 */
.sub-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 2px 10px;
}

.sub-h b {
  font-size: 14px;
  font-weight: 650;
}

.sub-s {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.fallback {
  margin-top: 14px;
}

/* ── 今天一行 ── */
.todayline {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 2px 10px;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.t-d {
  font-size: 13px;
  font-weight: 600;
  color: var(--wb-ink-2);
}

.t-i {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}

.t-i b {
  font-size: 15px;
  color: var(--wb-ink);
  font-variant-numeric: tabular-nums;
}

.t-i.hot b {
  color: #c0392b;
}

.t-i.warn b {
  color: #b26a00;
}

/* ── 快捷卡 ── */
.row-cards {
  display: flex;
  gap: 9px;
  overflow-x: auto;
  padding: 0 2px 12px;
  scrollbar-width: none;
}

.row-cards::-webkit-scrollbar {
  display: none;
}

.qc {
  flex: 0 0 auto;
  min-width: 108px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 11px 13px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  border-radius: 14px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.qc b {
  font-size: 21px;
  font-weight: 750;
  letter-spacing: -0.5px;
}

.qc-t {
  font-size: 12.5px;
  color: var(--wb-ink-2);
}

.qc-s {
  font-size: 11px;
  color: var(--wb-ink-3);
}

.qc.hot b {
  color: #c0392b;
}

.qc.cool b {
  color: var(--wb-primary);
}

.qc.warn b {
  color: #b26a00;
}

.qc:active {
  background: var(--wb-bg);
}

/* ── 区块 ── */
.sect {
  margin-top: 4px;
}

.s-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 2px 8px;
}

.s-h b {
  font-size: 14px;
  font-weight: 650;
}



/* ── 背一句的卡 ── */
.bcard {
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  padding: 14px;
}

.sn {
  margin-top: 8px;
  font-size: 16.5px;
  line-height: 1.65;
  color: var(--wb-ink);
}

.wrow {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.w {
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 22px;
  font-weight: 700;
  color: var(--wb-ink);
  padding: 0;
  cursor: pointer;
}

.ipa {
  font-size: 12px;
  color: var(--wb-ink-3);
}

.reveal {
  margin-top: 12px;
  width: 100%;
  padding: 10px;
  border: 1px dashed var(--wb-line);
  background: var(--wb-bg);
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.ans {
  margin-top: 12px;
  background: var(--wb-bg);
  border-radius: 12px;
  padding: 10px 12px;
}

.ans .g {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.ans .pos {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--wb-ink-3);
}

.ans .gt {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.5;
}

.ans .zh {
  margin-top: 5px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--wb-ink-2);
}

.ans .note {
  margin-top: 5px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--wb-ink-3);
}

.bacts {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

.skel .l {
  height: 13px;
  border-radius: 7px;
  background: linear-gradient(90deg, #ececf3 25%, #f6f6fa 37%, #ececf3 63%);
  background-size: 400% 100%;
  animation: sh 1.4s ease-in-out infinite;
  margin: 8px 0;
}

.w90 {
  width: 90%;
}

.w60 {
  width: 60%;
}

@keyframes sh {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

.empty {
  font-size: 16px;
  font-weight: 600;
}

.tap {
  font-size: 12.5px;
  color: var(--wb-ink-3);
  margin-top: 4px;
}

/* ── 最近在练 ── */
.rrow {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 7px;
  border: 0;
  background: var(--wb-card);
  border-radius: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.rrow:active {
  background: var(--wb-bg);
}

.rw {
  font-size: 15px;
  font-weight: 600;
  color: var(--wb-ink);
  flex: 0 0 auto;
}

.rg {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--wb-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rt {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.p-ld {
  padding: 24px 0;
}

.pacts {
  margin-top: 16px;
}

.p-empty {
  padding: 20px 0 12px;
  font-size: 13.5px;
  color: var(--wb-ink-2);
  text-align: center;
}

.p-choose {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 兜底入口只有一张按钮，不需要额外样式 */
</style>
