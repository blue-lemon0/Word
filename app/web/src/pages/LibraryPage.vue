<script setup lang="ts">
/** 词库页 —— 从「仓库台账」改成「学习地图」。
 *
 *  ★ 判据：打开这一页的人想问的是「我现在该练什么」，不是
 *    「库里有多少个 T1 词、有多少条缺例句」。所以：
 *    · 顶上是**今天**（到期几个、未到期几个、待学几个、已掌握几个）+ 一个开练按钮；
 *    · 列表按**学习状态分桶**（到期 / 未到期 / 待学 / 已掌握 / 搁置），
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
import { practicePool } from '../quiz'
import AddWordSheet from '../components/AddWordSheet.vue'
import BatchSentencesSheet from '../components/BatchSentencesSheet.vue'
import { SENTENCES_PER_SENSE, usableSentenceCounts } from '../sentence-health'
import type { Progress, Sense, Sentence, Word } from '../types'

const TARGET = SENTENCES_PER_SENSE
const router = useRouter()

/** 「新增词」弹层 */
const showAdd = ref(false)
/** 搜不到时一键加词：把搜索词直接带进 AddWordSheet，别让人再敲一遍 */
const addInitial = ref('')

function addFromSearch(): void {
  addInitial.value = q.value.trim().toLowerCase()
  if (!addInitial.value) return
  showAdd.value = true
}

interface Row {
  word: string
  ipa: string
  senses: Sense[]
  sentences: number
  target: number
  /** 只有 1 句可用例句的义项数 */
  single: number
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
  { key: 'learning', title: '未到期', hint: '练过，在等间隔', tone: 'warm' },
  { key: 'new', title: '待学', hint: '一次都没练过', tone: 'cool' },
  { key: 'mastered', title: '已掌握', hint: '90 天以上', tone: 'ok' },
  { key: 'idle', title: '不学', hint: '只查词，不复习', tone: 'mute' },
]

const rows = ref<Row[]>([])
const loading = ref(true)
const q = ref('')
/** 学习视角：要不要看某一桶；空 = 全看 */
const only = ref<Bucket | ''>('')
/** 维护视角（仓库口径）：默认关掉，展开才看 */
const maintain = ref(false)
const mFilter = ref<'rf' | 'ns' | 'one' | 'T1' | ''>('')

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
  const sentBy = usableSentenceCounts(srows)
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
    senses.sort((a, b) => a.slot - b.slot)
    let sentences = 0
    let single = 0
    let learned = 0
    let due = 0
    let dueAt = 0
    /** 一个词有多个义项时，这个词的桶 = 它**最紧要**的那个义项的桶 */
    let bucket: Bucket = 'mastered'
    let pinAt = 0
    /** 所有义项都设了「不学」的词，整词进最后一个桶 */
    let allSuspended = true
    const rank: Record<Bucket, number> = { due: 0, learning: 1, new: 2, mastered: 3, idle: 4 }
    for (const s of senses) {
      const n = sentBy.get(s.id) ?? 0
      sentences += n
      if (n === 1) single++
      const p = pmap.get(s.id)
      if (p && p.reps > 0) learned++
      // 义项级「不学」：不参与任何桶的紧迫度、到期数、pin
      if (p?.suspended) continue
      allSuspended = false
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
      single,
      dueAt,
      // 整词不学（hidden）或所有义项都不学：只进最后一个桶，不再抢复习注意力。
      bucket: hidden.has(word) || allSuspended ? 'idle' : bucket,
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
  // ★ 两个数依赖 rows（每个词有哪些义项），必须在 rows 就位之后再算
  if (readyFromMemory()) {
    void refreshPractisable()
    return
  }
  loading.value = true
  const [all, wrows, srows, prows] = await Promise.all([
    liveSenses(),
    allWords(),
    allSentences(),
    allProgress(),
  ])
  applyRows(buildRows(all, wrows, srows, prows))
  await refreshPractisable()
}

/** 出题池里的词各有多少（到期 / 待学）—— 顶部按钮的数字用它 */
async function refreshPractisable(): Promise<void> {
  const [pool, prows] = await Promise.all([practicePool(), allProgress()])
  const pmap = new Map(prows.map((p) => [p.senseId, p]))
  const now = Math.floor(Date.now() / 1000)
  const rankOf = (id: string): number => {
    const p = pmap.get(id)
    if (!p || p.reps === 0) return 2
    if (p.mastered && !p.rusty) return 3
    return p.dueAt <= now ? 0 : 1
  }
  const buckets = new Map<string, number>()
  for (const s of pool) {
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
  practisable.value = { due, new: fresh }

  // 库里存在、但没有任何可练义项的**词**（全都缺例句 / 被标记）——
  // 这些词点哪儿都练不到，是"卡住"的信号，值得在页面上出现一次
  const inPool = new Set(pool.map((s) => s.word))
  stuckList.value = rows.value
    .filter((r) => !inPool.has(r.word))
    .map((r) => ({ word: r.word, senses: r.senses.length }))
    .sort((a, b) => a.word.localeCompare(b.word))
}

/**
 * 顶部按钮上的数字：**只算练得到的词**（有例句、没被标记）。
 *
 * ★ 这一页的桶要如实显示"库里有什么"（含没有例句、待补内容的词），
 *   但「学几个新词 / 复习这 N 个」承诺的是一次练习 —— 数字必须和出题池一致，
 *   否则就会出现「说有新词可以学，点进去 0 题」。
 */
const practisable = ref<{ due: number; new: number }>({ due: 0, new: 0 })
/**
 * 库里有、但**一个可练义项都没有**的词（缺例句 / 全被标记）。
 *
 * ★ 为什么不复用「维护 → 缺例句」那个筛选：那个的口径是「句子数不足目标」，
 *   会把"有 5 句、目标 8 句"的词也算进来 —— 和这行提示说的「练不到」不是同一批。
 *   这里要的是精确集合，所以自己算；弹窗里也就能直接给「去补」。
 */
const stuckList = ref<{ word: string; senses: number }[]>([])
const stuckWords = computed(() => stuckList.value.length)
const singleSenses = computed(() => rows.value.reduce((n, r) => n + r.single, 0))
const stuckOpen = ref(false)
const batchOpen = ref(false)

function showStuck(): void {
  stuckOpen.value = true
}

/** 顶上的四个数：今天到期 / 未到期 / 待学 / 已掌握（都按**词**算） */
const head = computed(() => {
  const c: Record<Bucket, number> = { due: 0, learning: 0, new: 0, mastered: 0, idle: 0 }
  for (const r of rows.value) c[r.bucket]++
  return c
})

/**
 * 搜索 / 维护筛选后的行：**不包含 only 桶选择**。
 * 筛选按钮上的数字要来自这一层，所以点「未到期」不会把其它桶的数字变成 0；
 * 搜索或维护筛选变化时数字仍会跟着缩小，和列表里真正看到的范围一致。
 */
const scopedRows = computed(() => {
  const s = q.value.trim().toLowerCase()
  return rows.value.filter((r) => {
    if (s && !r.word.toLowerCase().includes(s)) return false
    if (!maintain.value) return true
    if (mFilter.value === 'rf' && !r.needsRefine) return false
    // 旧口径：一句都没有**也算缺（占位词的 target 可能为 0）
    //   写成 r.sentences >= r.target 会把最该补的那批筛掉）
    if (mFilter.value === 'ns' && r.sentences > 0 && r.sentences >= r.target) return false
    if (mFilter.value === 'one' && !r.single) return false
    if (mFilter.value === 'T1' && !r.senses.some((x) => x.tier === 'T1')) return false
    return true
  })
})

/** 每个桶里的词（桶内按「最该复习的在前」） */
const grouped = computed(() => {
  const map = new Map<Bucket, Row[]>()
  for (const b of BUCKETS) map.set(b.key, [])
  for (const r of scopedRows.value) {
    if (only.value && r.bucket !== only.value) continue
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

/** 折叠状态：默认只展开「到期 / 未到期 / 待学」—— 已掌握和搁置不该抢注意力 */
const collapsed = ref<Set<Bucket>>(new Set(['mastered', 'idle']))

function toggle(b: Bucket): void {
  const s = new Set(collapsed.value)
  if (s.has(b)) s.delete(b)
  else s.add(b)
  collapsed.value = s
}

/** 搜索结果、或者选了单一桶时，一律展开（否则「搜了却看不到」） */
const effectiveCollapsed = computed(() =>
  q.value.trim() || only.value || mFilter.value ? new Set<Bucket>() : collapsed.value,
)

const totalShown = computed(() => {
  let n = 0
  for (const list of grouped.value.values()) n += list.length
  return n
})

watch([q, only, maintain, mFilter], () => {
  limit.value = PAGE
})

/** 从某一桶直接开练：词库从「台账」变成「入口」的关键一步。
 *
 *  ★ 到期 / 新词不再开 /train 独立页 —— 首页的「复习 / 学习」tab 嵌的就是
 *    同一套 TrainSession、同一个 scope，再开一个带顶栏的独立页就是两个
 *    入口两套外壳（用户实测点「复习这 N 个」没落到首页复习 tab）。
 *    统一回首页切 tab；首页没有的桶（未到期）才走 /train。 */
function drill(scope: Bucket, n: number): void {
  if (!n) return
  if (scope === 'due' || scope === 'new') {
    void router.push({ path: '/', query: { tab: scope } })
    return
  }
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

/** 筛选按钮的数字：只看搜索/维护条件，不看当前选中的桶。 */
const chipCounts = computed(() => {
  const c: Record<Bucket, number> = { due: 0, learning: 0, new: 0, mastered: 0, idle: 0 }
  for (const r of scopedRows.value) c[r.bucket]++
  return c
})

function chipN(b: Bucket): number {
  return chipCounts.value[b]
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

    <van-popup
      :show="stuckOpen"
      position="bottom"
      round
      close-on-popstate
      @close="stuckOpen = false"
    >
      <div class="stuck-sheet">
        <h3>这些词暂时练不到</h3>
        <p class="sub">没有例句（或例句都被标记了），所以出不了题。补上就能进练习。</p>
        <div class="list">
          <button
            v-for="it in stuckList"
            :key="it.word"
            class="row"
            type="button"
            @click="stuckOpen = false; router.push(`/word/${encodeURIComponent(it.word)}`)"
          >
            <b>{{ it.word }}</b>
            <span class="n">{{ it.senses }} 个意思</span>
            <span class="go">去补 ›</span>
          </button>
        </div>
        <van-button block round @click="stuckOpen = false">知道了</van-button>
      </div>
    </van-popup>

    <AddWordSheet
      :open="showAdd"
      :initial="addInitial"
      @close="showAdd = false; addInitial = ''"
      @added="(id) => { showAdd = false; router.push(`/sense/${id}`) }"
      @filled="(w) => { showAdd = false; router.push(`/word/${encodeURIComponent(w)}`) }"
    />

    <BatchSentencesSheet
      :open="batchOpen"
      @close="batchOpen = false"
      @changed="load"
    />

    <div class="wb-wrap">
      <!-- 今天：一句话回答「我现在该干什么」 -->
      <section class="today">
        <p class="t-h">
          <template v-if="practisable.due">
            今天有 <b>{{ practisable.due }}</b> 个词到期
          </template>
          <template v-else-if="practisable.new">
            今天没有到期的 —— 有 <b>{{ practisable.new }}</b> 个新词可以学
          </template>
          <template v-else>今天没有要复习的</template>
        </p>
        <p class="t-s">
          未到期 {{ head.learning }} · 待学 {{ head.new }}<template
            v-if="practisable.new < head.new"
          >（{{ practisable.new }} 个有例句）</template> · 已掌握 {{ head.mastered }}
        </p>
        <div class="t-acts">
          <van-button
            v-if="practisable.due"
            type="primary"
            round
            block
            @click="drill('due', practisable.due)"
          >
            复习这 {{ practisable.due }} 个
          </van-button>
          <van-button
            v-else-if="practisable.new"
            type="primary"
            round
            block
            @click="drill('new', practisable.new)"
          >
            学几个新词
          </van-button>
          <!-- ★ 原来这里是「随便练两句」——随机已经搬到首页屏一了，别再留第二入口 -->
          <van-button v-else plain round block @click="router.push('/')">
            回首页随便刷两句
          </van-button>
        </div>
      </section>

      <button v-if="stuckWords > 0" class="stuck" type="button" @click="showStuck">
        <span class="ico">!</span>
        <span class="tx">
          有 <b>{{ stuckWords }}</b> 个词缺例句，练不到
        </span>
        <span class="go">去补 ›</span>
      </button>

      <button v-if="singleSenses > 0" class="stuck thin" type="button" @click="batchOpen = true">
        <span class="ico">!</span>
        <span class="tx">
          有 <b>{{ singleSenses }}</b> 个义项只有 1 句例句，复习时等于固定一句
        </span>
        <span class="go">批量补 ›</span>
      </button>

      <!-- 搜索 + 学习视角筛选一起吸顶：滚到下面找词时，两行都还在。
           数字只看搜索/维护条件，不随当前选中的桶变化。 -->
      <div class="findbar">
        <van-search v-model="q" placeholder="搜索我的词库" shape="round" class="sbox" />

        <!-- 学习视角的过滤：只留四个，而且都是「我现在想练什么」 -->
        <div class="chips">
          <button
            class="chip"
            :class="{ on: only === '' }"
            type="button"
            @click="only = ''"
          >
            全部 {{ scopedRows.length }}
          </button>
          <button
            v-for="b in BUCKETS.slice(0, 3)"
            :key="b.key"
            class="chip"
            :class="{ on: only === b.key, hot: b.key === 'due' && chipN(b.key) > 0 }"
            type="button"
            @click="only = only === b.key ? '' : b.key"
          >
            {{ b.title }} {{ chipN(b.key) }}
          </button>
        </div>
      </div>

      <van-loading v-if="loading" class="ld" color="#4f46e5">正在读库…</van-loading>
      <!-- 搜不到不是死胡同：这正是「想收这个词」的时刻，给个一键加入 -->
      <van-empty
        v-else-if="!totalShown"
        :description="q.trim() ? `库里没有「${q.trim()}」` : '没有匹配的词'"
      >
        <van-button
          v-if="q.trim()"
          round
          type="primary"
          size="small"
          icon="plus"
          @click="addFromSearch"
        >
          把「{{ q.trim() }}」加进词库
        </van-button>
      </van-empty>

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
                  <span v-if="r.single" class="warn">{{ r.single }} 个意思仅 1 句</span>
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
                { k: 'one', t: '仅 1 句' },
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
  /* 上内边距收窄（用户反馈：它把下面「缺例句」提示条挤得显示不全）——
     板块的第一印象由标题承担，不靠留白 */
  padding: 10px 16px 14px;
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
  margin-top: 8px;
}

/* ── 搜索与 chips ── */
.stuck-sheet {
  padding: 18px 16px calc(18px + env(safe-area-inset-bottom, 0px));
}

.stuck-sheet h3 {
  font-size: 16px;
  font-weight: 650;
  color: var(--wb-ink);
}

.stuck-sheet .sub {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}

.stuck-sheet .list {
  max-height: 46vh;
  overflow-y: auto;
  margin-bottom: 14px;
}

.stuck-sheet .row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 11px 4px;
  border: 0;
  border-bottom: 1px solid var(--wb-line);
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.stuck-sheet .row b {
  font-size: 15px;
  color: var(--wb-ink);
}

.stuck-sheet .row .n {
  font-size: 12px;
  color: var(--wb-ink-3);
}

.stuck-sheet .row .go {
  margin-left: auto;
  font-size: 12.5px;
  color: var(--wb-primary);
}

.stuck {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  /* 下面吸顶搜索框用 margin-top:-8px + 10px 反向阴影往上盖（堵吸顶缝），
     这 18px 会落在前一个元素身上 —— 底边距留不够，提示条的下半截
     连边框一起被它盖掉（用户反馈「下半边框看不见」，坑见踩坑 77）。 */
  margin: 0 0 20px;
  padding: 10px 12px;
  border: 1px solid #f0d9a8;
  border-radius: 12px;
  background: #fff8e8;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.stuck + .stuck {
  margin-top: -10px;
}

.stuck .ico {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #d99a2b;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}

.stuck .tx {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #7a5a12;
}

.stuck .go {
  flex: 0 0 auto;
  font-size: 12.5px;
  color: #a1721a;
}

.sbox {
  /* 吸在顶栏下面：滚到下面找词时，搜索框还在。 */
  position: sticky;
  top: calc(var(--wb-sb-h) + 43px);
  z-index: 12;
  /* 往上多盖一点：顶栏下沿到搜索框之间有几个像素的缝，
     缝隙里会露出正在滚动的词条（看起来就像搜索框底色是破的）。 */
  padding: 8px 0 6px;
  margin: -8px 0 6px;
  /* 必须是**不透明**底色：吸顶元素只覆盖自己的盒子，背景透明时
     下面的词条会从搜索框周围透出来（看起来像"搜索框是空的飘在上面"）。 */
  background: var(--wb-bg);
  /* 再往上一截涂同一底色：吸顶后它正上方的 1~2px 缝隙里会露出滚过去的词条 */
  box-shadow: 0 -10px 0 0 var(--wb-bg);
  --van-search-background: transparent;
  --van-search-content-background: var(--wb-card);
}

/* 搜索框和筛选按钮一起吸顶。外层负责遮住滚过去的词条，
   内层搜索框取消自己的 sticky，避免两层各自粘顶。 */
.findbar {
  position: sticky;
  top: calc(var(--wb-sb-h) + 43px);
  z-index: 12;
  /* 底部留出内边距，吸顶时才不会让卡片贴着筛选按钮 */
  padding: 8px 0 8px;
  margin: -8px 0 6px;
  background: var(--wb-bg);
  box-shadow: 0 -10px 0 0 var(--wb-bg);
}

.findbar .sbox {
  position: static;
  padding: 0 0 6px;
  margin: 0;
  background: transparent;
  box-shadow: none;
}

.findbar .chips {
  margin: 0;
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
