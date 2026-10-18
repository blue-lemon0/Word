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
  dueN.value = due
  learningN.value = learn
  freshN.value = fresh
  flagN.value = flags.length
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
  router.push({
    path: '/train',
    query: { solo: c.senseId, sent: String(c.sentence.id) },
  })
}

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

/** 快捷卡：点哪张就带着对应 scope 进训练页（只深一层） */
interface Quick {
  key: string
  n: number
  title: string
  sub: string
  to: string
  tone: 'hot' | 'cool' | 'warn' | 'ink'
}

const quicks = computed<Quick[]>(() =>
  [
    { key: 'due', n: dueN.value, title: '今天复习', sub: '到期就练', to: '/train?scope=due', tone: 'hot' as const },
    { key: 'new', n: freshN.value, title: '学新词', sub: '一次都没练过', to: '/train?scope=new', tone: 'cool' as const },
    { key: 'flag', n: flagN.value, title: '错题', sub: '标记过的句子', to: '/board', tone: 'warn' as const },
    { key: 'learn', n: learningN.value, title: '在学', sub: '再刷一遍', to: '/train?scope=learning', tone: 'ink' as const },
  ].filter((q) => q.n > 0),
)

function go(to: string): void {
  router.push(to)
}

onMounted(async () => {
  if (card.value === undefined) await roll()
  await Promise.all([loadToday(), loadRecent()])
})
</script>

<template>
  <div class="wb-page home">
    <div class="wb-wrap">
      <InstallPrompt />

      <!-- 一行「今天」：四个数字，读到就知道现在是什么状态 -->
      <div class="todayline">
        <span class="t-d">今天</span>
        <span class="t-i hot"><b>{{ dueN }}</b> 到期</span>
        <span class="t-i"><b>{{ learningN }}</b> 在学</span>
        <span class="t-i"><b>{{ freshN }}</b> 待学</span>
        <span v-if="flagN" class="t-i warn"><b>{{ flagN }}</b> 错题</span>
      </div>

      <!-- 快捷卡：横滑，每张通向一个具体动作 -->
      <div v-if="quicks.length" class="row-cards">
        <button
          v-for="q in quicks"
          :key="q.key"
          class="qc"
          :class="q.tone"
          type="button"
          @click="go(q.to)"
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
          <span class="wb-sp" />
          <button class="s-act" type="button" @click="roll">
            <van-icon name="replay" size="13" />
            换一个
          </button>
        </header>

        <div v-if="card" class="bcard">
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
          <div class="wrow">
            <button class="w" type="button" @click="go(`/word/${encodeURIComponent(card.word)}`)">
              {{ card.word }}
            </button>
            <span v-if="card.ipa" class="ipa">/{{ card.ipa }}/</span>
          </div>

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

      <!-- 最近在练 -->
      <section v-if="recent.length" class="sect">
        <header class="s-h">
          <b>最近在练</b>
          <span class="wb-sp" />
          <button class="s-act" type="button" @click="go('/library')">词库 ›</button>
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

      <!-- 底部入口 -->
      <div class="row-links">
        <button class="lk" type="button" @click="go('/train')">
          <van-icon name="aim" size="16" />
          去训练
        </button>
        <button class="lk" type="button" @click="go('/library')">
          <van-icon name="apps-o" size="16" />
          我的词库
        </button>
        <button class="lk" type="button" @click="go('/more')">
          <van-icon name="ellipsis" size="16" />
          更多
        </button>
      </div>
    </div>

    <WordPeek :show="peekOpen" :token="peekToken" @close="peekOpen = false" />
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

.wb-wrap {
  padding-top: calc(12px + env(safe-area-inset-top, 0px));
  padding-bottom: calc(14px + var(--wb-tabbar-h));
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

.s-act {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--wb-primary);
  padding: 4px 2px;
  cursor: pointer;
}

/* ── 背一句的卡 ── */
.bcard {
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  padding: 14px;
}

.sn {
  font-size: 16.5px;
  line-height: 1.65;
  color: var(--wb-ink);
}

.wrow {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 10px;
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

/* ── 底部入口 ── */
.row-links {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.lk {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 10px 6px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  border-radius: 12px;
  font-family: inherit;
  font-size: 13px;
  color: var(--wb-ink-2);
  cursor: pointer;
}

.lk:active {
  background: var(--wb-bg);
}
</style>
