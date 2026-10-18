<script setup lang="ts">
/** 词库页 —— 可搜索、可筛选的列表。状态列直接驱动「该去补哪些词」，
 *  所以筛选器按「缺什么」排：需精修 / 缺例句 / T1 / 未掌握。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { allProgress, allSentences, allWords, cachedNow, liveSenses } from '../db'
import AddWordSheet from '../components/AddWordSheet.vue'
import type { Progress, Sense, Sentence, Word } from '../types'

const TARGET = 5

/** 「新增词」弹层 */
const showAdd = ref(false)

interface Row {
  word: string
  ipa: string
  senses: Sense[]
  sentences: number
  target: number
  prog: Map<string, Progress>
  needsRefine: boolean
  learned: number
  due: number
}

const router = useRouter()
const q = ref('')
const filter = ref<'all' | 'rf' | 'ns' | 'T1' | 'unm'>('all')
const rows = ref<Row[]>([])
const loading = ref(true)
/** 分段渲染：全库 3000 词一次性铺 3000 个 DOM 行，首屏会卡住。
 *  先渲染前 120 行，滚到底再加载下一段 —— 数据早就在内存里，只是别一次画完。 */
const PAGE = 120
const limit = ref(PAGE)

/**
 * 组表。四张表都已经在内存里时**同步**算完 —— 词库页是底部 tab 的常驻页面，
 * 从别的 tab 切过来时那一帧「正在读库… · 0 词」正是用户说的那种闪
 * （screencast 抓到过：15 KB vs 稳定 37 KB）。
 * 表没热（冷启动第一眼）才走异步。
 */
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
  // 一次 bulkGet 拿全部进度，按 senseId 索引 —— 不要在词循环里 await，
  // 那是 3000 次串行查询，打开词库要等好几秒。
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
    const prog = new Map<string, Progress>()
    for (const s of senses) {
      sentences += sentBy.get(s.id) ?? 0
      const p = pmap.get(s.id)
      if (p) {
        prog.set(s.id, p)
        if (p.reps > 0) learned++
        if (p.reps > 0 && !p.mastered && p.dueAt <= now) due++
      }
    }
    list.push({
      word,
      ipa: ipaOf.get(word) ?? '',
      senses,
      sentences,
      target: senses.length * TARGET,
      prog,
      needsRefine: senses.some((s) => s.needsRefine),
      learned,
      due,
    })
  }
  list.sort((a, b) => a.word.localeCompare(b.word))
  return list
}

function applyRows(list: Row[]): void {
  rows.value = list
  limit.value = PAGE
  loading.value = false
}

/** 内存里四张表都齐吗？齐了就同步出列表。 */
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

const FILTERS = [
  { text: '全部', value: 'all' },
  { text: '需精修', value: 'rf' },
  { text: '缺例句', value: 'ns' },
  { text: 'T1', value: 'T1' },
  { text: '未掌握', value: 'unm' },
] as const

const shown = computed(() => {
  const s = q.value.trim().toLowerCase()
  let list = rows.value
  if (s) list = list.filter((r) => r.word.toLowerCase().includes(s))
  switch (filter.value) {
    case 'rf':
      return list.filter((r) => r.needsRefine)
    case 'ns':
      return list.filter((r) => r.sentences < r.target)
    case 'T1':
      return list.filter((r) => r.senses.some((x) => x.tier === 'T1'))
    case 'unm':
      return list.filter((r) => r.learned < r.senses.length)
    default:
      return list
  }
})

/** 搜索/筛选条件一变就回到第一段，否则可能停在一个空白的第 900 行 */
watch([q, filter], () => {
  limit.value = PAGE
})

const totals = computed(() => {
  const needRefine = rows.value.filter((r) => r.needsRefine).length
  const noSent = rows.value.filter((r) => r.sentences < r.target).length
  return { words: rows.value.length, needRefine, noSent }
})

function stateOf(r: Row): { text: string; type: 'success' | 'warning' | 'default' } {
  if (r.learned === r.senses.length) return { text: '全掌握', type: 'success' }
  if (r.learned > 0) return { text: `${r.learned}/${r.senses.length}`, type: 'warning' }
  return { text: '未学', type: 'default' }
}

/* 原来这里有个「导入内容包」按钮，自己 createElement('input') 选文件、
   自己调 importBundle、自己拼提示语。它和「更多」页的「导入备份」是
   同一件事的两半：用户手上只有一个 .json 文件，他不该需要先判断它是哪种，
   而文件里的 format 字段本来就能回答这个问题。

   合并到「更多 → 备份与导入 → 导入」一个入口（见 MorePage.applyIncoming）：
   一个按钮、按格式分派、并且从微信/QQ 里直接点开文件也能走同一条路。

   词库页留一句指路就够了 —— 首次启动若词库是空的，首页也写着「先去词库导入」。 */

onMounted(load)
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <h1>词库</h1>
        <!-- 「加一个词」是这里最该常驻的动作。
             之前界面上**根本没有建词路径**（db.words.put 只出现在备份恢复
             和两种导入里），想加一个词只能导入整个内容包 ——
             那不叫「加词」，那叫「换数据库」。
             一个「+」放在顶栏，是通讯录式的通用预期。 -->
        <van-button size="mini" plain type="primary" icon="plus" @click="showAdd = true">
          新词
        </van-button>
      </div>
    </header>

    <AddWordSheet
      :open="showAdd"
      @close="showAdd = false"
      @added="(id) => { showAdd = false; router.push(`/sense/${id}`) }"
    />

    <div class="wb-wrap">
      <van-tabs
        v-model:active="filter"
        sticky
        color="#4f46e5"
        title-active-color="#4f46e5"
        title-inactive-color="#969baa"
        line-width="16"
        class="tabs"
      >
        <van-tab v-for="f in FILTERS" :key="f.value" :name="f.value" :title="f.text" />
      </van-tabs>

      <van-search v-model="q" placeholder="搜索单词" shape="round" class="sbox" />

      <p class="sum">
        {{ totals.words }} 词 · 需精修 {{ totals.needRefine }} · 缺例句 {{ totals.noSent }}
      </p>

      <van-loading v-if="loading" class="ld" color="#4f46e5">正在读库…</van-loading>
      <van-empty v-else-if="!shown.length" description="没有匹配的词" />

      <div
        v-for="r in shown.slice(0, limit)"
        :key="r.word"
        class="row-i"
        @click="router.push(`/word/${r.word}`)"
      >
        <div class="b">
          <div class="w">
            {{ r.word }}
            <span class="ipa">{{ r.ipa }}</span>
          </div>
          <div class="m">
            <span>{{ r.senses.length }} 个意思</span>
            <span>{{ r.sentences }}/{{ r.target }} 句</span>
            <span v-if="r.due" class="due">{{ r.due }} 到期</span>
          </div>
        </div>
        <div class="tags">
          <van-tag v-if="r.needsRefine" plain round type="warning">需精修</van-tag>
          <van-tag v-if="r.sentences < r.target" plain round>缺句</van-tag>
          <van-tag plain round :type="stateOf(r).type">{{ stateOf(r).text }}</van-tag>
        </div>
      </div>

      <van-button
        v-if="shown.length > limit"
        class="more"
        size="small"
        plain
        block
        @click="limit += PAGE"
      >
        显示更多（还有 {{ shown.length - limit }} 个词）
      </van-button>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  margin: 0 -12px;
  --van-tabs-line-height: 40px;
  --van-tabs-nav-background: var(--wb-bg);
}

.sbox {
  margin: 4px 0 0;
  background: transparent;
  --van-search-background: transparent;
  --van-search-content-background: var(--wb-card);
}

.sum {
  font-size: 12px;
  color: var(--wb-ink-3);
  margin: 6px 4px 10px;
}

.ld {
  padding: 30px 0;
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
  color: var(--wb-primary);
}

.tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 46%;
}

.more {
  margin-top: 10px;
}
</style>