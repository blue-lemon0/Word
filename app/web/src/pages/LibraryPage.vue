<script setup lang="ts">
/** 词库页 —— 从「仓库台账」改成「学习地图」。
 *
 *  ★ 判据：打开这一页的人想问的是「我现在该练什么」，不是
 *    「库里有多少个 T1 词、有多少条缺例句」。所以：
 *    · 顶上是**今天**（到期几个、在学几个、待学几个、已掌握几个）+ 一个开练按钮；
 *    · 列表按**学习状态分桶**（到期 / 在学 / 待学 / 已掌握 / 搁置），
 *      每桶可折叠、可「练这一桶」；
 *    · 仓库口径（需精修 / 缺例句 / T1）降级成「维护」筛选 —— 它们仍然有用，
 *      但那是**内容生产**的视角，不是学习的视角。
 *
 *  ★ 排序也换了：以前按字母（找词方便，但打开先看到一堆「用不上」的词），
 *    现在桶内按「最该复习的在前」：到期早的在前，新词按字母。
 *
 *  ★ 性能照旧走两档：四张表已在内存就同步出列表（切 tab 那一帧不闪），
 *    冷启动才异步等。见 db.ts 的 cachedNow。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { allProgress, allSentences, allWords, cachedNow, liveSenses } from '../db'
import AddWordSheet from '../components/AddWordSheet.vue'
import type { Progress, Sense, Sentence, Word } from '../types'

const TARGET = 5
const router = useRouter()

/** 「新增词」弹层 */
const showAdd = ref(false)

interface Row {
  word: string
  ipa: string
  senses: Sense[]
  sentences: number
  target: number
  /** 该词最该被复习的时刻（秒）；没有进度就是 0 */
  dueAt: number
  /** 桶 */
  bucket: Bucket
  learned: number
  due: number
  needsRefine: boolean
  /** 「排进明天练」的时间戳（0 = 没排） */
  pinAt: number
}

/** 五个桶 —— 顺序就是「人心里想事情的顺序」 */
type Bucket = 'due' | 'learning' | 'new' | 'mastered' | 'idle'

const BUCKETS: Array<{ key: Bucket; title: string; hint: string; tone: string }> = [
  { key: 'due', title: '今天到期', hint: '该复习了', tone: 'hot' },
  { key: 'learning', title: '在学', hint: '还没到期', tone: 'warm' },
  { key: 'new', title: '待学', hint: '一次都没练过', tone: 'cool' },
  { key: 'mastered', title: '已掌握', hint: '90 天以上', tone: 'ok' },
  { key: 'idle', title: '搁置', hint: '暂时不学', tone: 'mute' },
]

const rows = ref<Row[]>([])
const loading = ref(true)
const q = ref('')
/** 学习视角：要不要看某一桶；空 = 全看 */
const only = ref<Bucket | ''>('')
/** 维护视角（仓库口径）：默认关掉，展开才看 */
const maintain = ref(false)
const mFilter = ref<'rf' | 'ns' | 'T1' | ''>('')

const PAGE = 120
const limit = ref(PAGE)

function bucketOf(p: Progress | undefined, now: number): Bucket {
  if (!p || p.reps === 0) return 'new'
  if (p.mastered && !p.rusty) return 'mastered'
  if (p.dueAt <= now) return 'due'
  return 'learning'
}

function buildRows(
  all: Sense[],
  wrows: Word[],
  srows: Sentence[],
  prows: Progress[],
): Row[] {
  const ipaOf = new Map(wrows.map((w) => [w.word, w.ipa]))
  const hidden = new Set(wrows.filter((w) => w.hidden).map((w) => w.word))
  const sentBy = new Map<string, number>()
  for (const s of srows) sentBy.set(s.senseId, (sentBy.get(s.senseId) ?? 0) + 1)
  const pmap = new Map<string, Progress>()
  for (const p of prows) pmap.set(p.senseId, p)

  const byWord = new Map<string, Sense[]>()
  for (const s of all) {
    const arr = byWord.get(s.word)
    if (arr) arr.push(s)
    else byWord.set(s.word, [s])
  }

  const now = Math.floor(Date.now() / 1000)
  const list: Row[] = []
  for (const [word, senses] of byWord) {
    if (hidden.has(word)) continue
    senses.sort((a, b) => a.slot - b.slot)
    let sentences = 0
    let learned = 0
    let due = 0
    let dueAt = 0
    /** 一个词有多个义项时，这个词的桶 = 它**最紧要**的那个义项的桶 */
    let bucket: Bucket = 'mastered'
    let pinAt = 0
    const rank: Record<Bucket, number> = { due: 0, learning: 1, new: 2, mastered: 3, idle: 4 }
    for (const s of senses) {
      sentences += sentBy.get(s.id) ?? 0
      const p = pmap.get(s.id)
      if (p && p.reps > 0) learned++
      if (p && p.reps > 0 && !p.mastered && p.dueAt <= now) due++
      if (p?.pinAt && p.pinAt > now && (pinAt === 0 || p.pinAt < pinAt)) pinAt = p.pinAt
      const b = bucketOf(p, now)
      if (rank[b] < rank[bucket]) bucket = b
      if (b === 'due' && p && (dueAt === 0 || p.dueAt < dueAt)) dueAt = p.dueAt
    }
    list.push({
      word,
      ipa: ipaOf.get(word) ?? '',
      senses,
      sentences,
      target: senses.length * TARGET,
      dueAt,
      bucket,
      learned,
      due,
      pinAt,
      needsRefine: senses.some((s) => s.needsRefine),
    })
  }
  return list
}

function applyRows(list: Row[]): void {
  rows.value = list
  limit.value = PAGE
  loading.value = false
}

function readyFromMemory(): boolean {
  const all = cachedNow<Sense[]>('liveSenses')
  const wrows = cachedNow<Word[]>('words')
  const srows = cachedNow<Sentence[]>('sentences')
  const prows = cachedNow<Progress[]>('progress')
  if (!all || !wrows || !srows || !prows) return false
  applyRows(buildRows(all, wrows, srows, prows))
  return true
}

async function load(): Promise<void> {
  if (readyFromMemory()) return
  loading.value = true
  const [all, wrows, srows, prows] = await Promise.all([
    liveSenses(),
    allWords(),
    allSentences(),
    allProgress(),
  ])
  applyRows(buildRows(all, wrows, srows, prows))
}

/** 顶上的四个数：今天到期 / 在学 / 待学 / 已掌握（都按**词**算） */
const head = computed(() => {
  const c: Record<Bucket, number> = { due: 0, learning: 0, new: 0, mastered: 0, idle: 0 }
  for (const r of rows.value) c[r.bucket]++
  return c
})

/** 每个桶里的词（桶内按「最该复习的在前」） */
const grouped = computed(() => {
  const s = q.value.trim().toLowerCase()
  const map = new Map<Bucket, Row[]>()
  for (const b of BUCKETS) map.set(b.key, [])
  for (const r of rows.value) {
    if (s && !r.word.toLowerCase().includes(s)) continue
    if (only.value && r.bucket !== only.value) continue
    if (maintain.value) {
      if (mFilter.value === 'rf' && !r.needsRefine) continue
      if (mFilter.value === 'ns' && r.sentences >= r.target) continue
      if (mFilter.value === 'T1' && !r.senses.some((x) => x.tier === 'T1')) continue
    }
    map.get(r.bucket)!.push(r)
  }
  for (const [k, list] of map) {
    list.sort((a, b) => {
      if (k === 'due') return (a.dueAt || Infinity) - (b.dueAt || Infinity)
      if (k === 'learning') return a.word.localeCompare(b.word)
      return a.word.localeCompare(b.word)
    })
  }
  return map
})

/** 折叠状态：默认只展开「到期 / 在学 / 待学」—— 已掌握和搁置不该抢注意力 */
const collapsed = ref<Set<Bucket>>(new Set(['mastered', 'idle']))

function toggle(b: Bucket): void {
  const s = new Set(collapsed.value)
  if (s.has(b)) s.delete(b)
  else s.add(b)
  collapsed.value = s
}

/** 搜索结果、或者选了单一桶时，一律展开（否则「搜了却看不到」） */
const effectiveCollapsed = computed(() =>
  q.value.trim() || only.value ? new Set<Bucket>() : collapsed.value,
)

const totalShown = computed(() => {
  let n = 0
  for (const list of grouped.value.values()) n += list.length
  return n
})

watch([q, only, maintain, mFilter], () => {
  limit.value = PAGE
})

/** 从某一桶直接开练：词库从「台账」变成「入口」的关键一步 */
function drill(scope: Bucket, n: number): void {
  if (!n) return
  void router.push({ path: '/train', query: { scope } })
}

function fmtDue(ts: number): string {
  if (!ts) return ''
  const days = Math.round((ts - Date.now() / 1000) / 86400)
  if (days <= 0) return '今天'
  if (days === 1) return '明天'
  return `${days} 天后`
}

function bucketN(b: Bucket): number {
  return grouped.value.get(b)?.length ?? 0
}

onMounted(load)
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <h1>我的词库</h1>
        <van-button size="mini" plain @click="router.push('/board')">错题</van-button>
        <van-button size="mini" plain type="primary" icon="plus" @click="showAdd = true">
          新词
        </van-button>
      </div>
    </header>

    <AddWordSheet
      :open="showAdd"
      @close="showAdd = false"
      @added="(id) => { showAdd = false; router.push(`/sense/${id}`) }"
      @filled="(w) => { showAdd = false; router.push(`/word/${encodeURIComponent(w)}`) }"
    />

    <div class="wb-wrap">
      <!-- 今天：一句话回答「我现在该干什么」 -->
      <section class="today">
        <p class="t-h">
          <template v-if="head.due">
            今天有 <b>{{ head.due }}</b> 个词到期
          </template>
          <template v-else-if="head.new">
            今天没有到期的 —— 有 <b>{{ head.new }}</b> 个新词可以学
          </template>
          <template v-else>今天没有要复习的</template>
        </p>
        <p class="t-s">
          在学 {{ head.learning }} · 待学 {{ head.new }} · 已掌握 {{ head.mastered }}
        </p>
        <div class="t-acts">
          <van-button
            v-if="head.due"
            type="primary"
            round
            block
            @click="drill('due', head.due)"
          >
            复习这 {{ head.due }} 个
          </van-button>
          <van-button v-else-if="head.new" type="primary" round block @click="drill('new', head.new)">
            学几个新词
          </van-button>
          <van-button v-else plain round block @click="router.push('/train')">
            随便练两句
          </van-button>
        </div>
      </section>

      <van-search v-model="q" placeholder="搜索我的词库" shape="round" class="sbox" />

      <!-- 学习视角的过滤：只留四个，而且都是「我现在想练什么」 -->
      <div class="chips">
        <button
          class="chip"
          :class="{ on: only === '' }"
          type="button"
          @click="only = ''"
        >
          全部 {{ rows.length }}
        </button>
        <button
          v-for="b in BUCKETS.slice(0, 3)"
          :key="b.key"
          class="chip"
          :class="{ on: only === b.key, hot: b.key === 'due' && bucketN(b.key) > 0 }"
          type="button"
          @click="only = only === b.key ? '' : b.key"
        >
          {{ b.title }} {{ bucketN(b.key) }}
        </button>
      </div>

      <van-loading v-if="loading" class="ld" color="#4f46e5">正在读库…</van-loading>
      <van-empty v-else-if="!totalShown" description="没有匹配的词" />

      <!-- 分桶列表 -->
      <template v-if="!loading">
        <section v-for="b in BUCKETS" :key="b.key" class="bucket">
          <header
            v-if="bucketN(b.key)"
            class="b-h"
            :class="b.tone"
            @click="toggle(b.key)"
          >
            <span class="b-t">{{ b.title }}</span>
            <span class="b-n">{{ bucketN(b.key) }}</span>
            <span class="b-hint">{{ b.hint }}</span>
            <span class="wb-sp" />
            <button
              v-if="b.key === 'due' || b.key === 'new' || b.key === 'learning'"
              class="b-go"
              type="button"
              @click.stop="drill(b.key, bucketN(b.key))"
            >
              练这组
            </button>
            <van-icon
              :name="effectiveCollapsed.has(b.key) ? 'arrow-down' : 'arrow-up'"
              size="12"
              class="b-ic"
            />
          </header>

          <template v-if="bucketN(b.key) && !effectiveCollapsed.has(b.key)">
            <div
              v-for="r in (grouped.get(b.key) ?? []).slice(0, limit)"
              :key="r.word"
              class="row-i"
              @click="router.push(`/word/${encodeURIComponent(r.word)}`)"
            >
              <div class="b">
                <div class="w">
                  {{ r.word }}
                  <span v-if="r.ipa" class="ipa">{{ r.ipa }}</span>
                </div>
                <div class="m">
                  <span>{{ r.senses.length }} 个意思</span>
                  <span v-if="r.pinAt" class="pin">明天练</span>
                  <span v-if="r.bucket === 'due' && r.dueAt" class="due">
                    {{ fmtDue(r.dueAt) }}到期
                  </span>
                  <span v-else-if="r.learned">{{ r.learned }}/{{ r.senses.length }} 练过</span>
                  <span v-else>没练过</span>
                  <span v-if="r.needsRefine" class="warn">待补内容</span>
                </div>
              </div>
              <van-icon name="arrow" size="12" class="go" />
            </div>
          </template>
        </section>

        <van-button
          v-if="totalShown > limit"
          class="more"
          size="small"
          plain
          block
          @click="limit += PAGE"
        >
          显示更多（还有 {{ totalShown - limit }} 个词）
        </van-button>
      </template>

      <!-- 维护视角：内容生产的口径，收在下面，默认关 -->
      <section class="maint">
        <button class="m-t" type="button" @click="maintain = !maintain">
          <van-icon :name="maintain ? 'arrow-up' : 'arrow-down'" size="12" />
          维护词库（内容视角）
        </button>
        <template v-if="maintain">
          <p class="m-hint">
            这几个筛选是给**补内容**用的：词库本身还不是成品，需要人（或 AI）把空壳补上。
          </p>
          <div class="chips">
            <button
              v-for="f in ([
                { k: 'rf', t: '需精修' },
                { k: 'ns', t: '缺例句' },
                { k: 'T1', t: 'T1 高频' },
              ] as const)"
              :key="f.k"
              class="chip"
              :class="{ on: mFilter === f.k }"
              type="button"
              @click="mFilter = mFilter === f.k ? '' : f.k"
            >
              {{ f.t }}
            </button>
            <button class="chip" type="button" @click="router.push('/audit')">AI 体检</button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* ── 今天 ── */
.today {
  background: linear-gradient(135deg, #f5f3ff 0%, #eef2ff 100%);
  border: 1px solid #e6e6f7;
  border-radius: 16px;
  padding: 16px;
  margin-bottom: 12px;
}

.t-h {
  font-size: 16px;
  font-weight: 650;
  color: var(--wb-ink);
  line-height: 1.5;
}

.t-h b {
  color: var(--wb-primary);
  font-size: 19px;
}

.t-s {
  margin-top: 4px;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.t-acts {
  margin-top: 12px;
}

/* ── 搜索与 chips ── */
.sbox {
  margin: 0 0 6px;
  background: transparent;
  --van-search-background: transparent;
  --van-search-content-background: var(--wb-card);
}

.chips {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin: 2px 0 12px;
}

.chip {
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  border-radius: 999px;
  padding: 5px 11px;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--wb-ink-2);
  cursor: pointer;
}

.chip.on {
  background: var(--wb-primary);
  border-color: var(--wb-primary);
  color: #fff;
}

.chip.hot:not(.on) {
  border-color: #f0b4b4;
  color: #c0392b;
}

.ld {
  padding: 30px 0;
}

/* ── 桶 ── */
.bucket {
  margin-bottom: 6px;
}

.b-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 4px;
  cursor: pointer;
}

.b-t {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--wb-ink);
}

.b-n {
  font-size: 12px;
  color: var(--wb-ink-3);
  font-variant-numeric: tabular-nums;
}

.b-hint {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.b-h.hot .b-t {
  color: #c0392b;
}

.b-h.warm .b-t {
  color: #b26a00;
}

.b-h.cool .b-t {
  color: var(--wb-primary);
}

.b-go {
  border: 0;
  background: var(--primary-soft);
  color: var(--primary);
  font-family: inherit;
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 999px;
  cursor: pointer;
}

.b-ic {
  color: var(--wb-ink-3);
  margin-left: 2px;
}

.row-i {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  padding: 11px 13px;
  margin-bottom: 8px;
  cursor: pointer;
}

.row-i:active {
  background: var(--wb-bg);
}

.row-i .b {
  flex: 1;
  min-width: 0;
}

.row-i .w {
  font-size: 15px;
  font-weight: 600;
}

.row-i .ipa {
  color: var(--wb-ink-3);
  font-size: 11.5px;
  font-weight: 400;
  margin-left: 6px;
}

.row-i .m {
  font-size: 11.5px;
  color: var(--wb-ink-2);
  margin-top: 3px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.row-i .due {
  color: #c0392b;
}

.row-i .pin {
  color: var(--primary);
  font-weight: 600;
}

.row-i .warn {
  color: #b26a00;
}

.row-i .go {
  color: var(--wb-ink-3);
}

.more {
  margin-top: 10px;
}

/* ── 维护视角 ── */
.maint {
  margin-top: 18px;
  border-top: 1px solid var(--wb-line);
  padding-top: 12px;
}

.m-t {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--wb-ink-3);
  padding: 4px 2px;
  cursor: pointer;
}

.m-hint {
  margin: 6px 2px 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}
</style>
