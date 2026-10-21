<script setup lang="ts">
/** 批量补单句义项 —— 一屏里把「待补 → 生成 → 检查 → 应用」走完。
 *
 *  仍然守 D38：AI 只出提议，生成完先摆出来，点「应用」才写库。
 *  和逐页补的区别只是把 47 次页面往返收进一个队列，不是让 AI 直接改库。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import { allSentences, allWords, db, liveSenses } from '../db'
import { addSentence } from '../ai/actions'
import { applyAll } from '../ai/apply'
import { aiReady } from '../ai/config'
import { AiError, describeAiError, type Proposal } from '../ai/types'
import { usableSentenceCounts } from '../sentence-health'
import { toast } from '../toast'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

type AddProposal = Extract<Proposal, { kind: 'sentence.add' }>

interface Target {
  id: string
  word: string
  slot: number
  pos: string
  gloss: string
}

interface Generated {
  target: Target
  proposals: AddProposal[]
  cached: boolean
}

interface Problem {
  word: string
  slot: number
  message: string
}

const HOW_MANY = 3

const phase = ref<'pick' | 'gen' | 'review' | 'done'>('pick')
const loading = ref(false)
const list = ref<Target[]>([])
const selected = ref<string[]>([])
const queue = ref<Target[]>([])
const results = ref<Generated[]>([])
const problems = ref<Problem[]>([])
const excluded = ref<Set<string>>(new Set())
const finished = ref(0)
const total = ref(0)
const current = ref('')
const stopRequested = ref(false)
const applying = ref(false)
const stopped = ref(false)
const doneMessage = ref('')

const aiOn = aiReady

const allSelected = computed(
  () => list.value.length > 0 && selected.value.length === list.value.length,
)

function isSelected(id: string): boolean {
  return selected.value.includes(id)
}

function toggle(id: string): void {
  if (phase.value !== 'pick') return
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = [...next]
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : list.value.map((s) => s.id)
}

async function load(): Promise<void> {
  loading.value = true
  phase.value = 'pick'
  results.value = []
  problems.value = []
  excluded.value = new Set()
  queue.value = []
  finished.value = 0
  total.value = 0
  current.value = ''
  stopRequested.value = false
  stopped.value = false
  applying.value = false
  doneMessage.value = ''
  try {
    const [senses, sentences, words] = await Promise.all([
      liveSenses(),
      allSentences(),
      allWords(),
    ])
    const countOf = usableSentenceCounts(sentences)
    const hidden = new Set(words.filter((w) => w.hidden).map((w) => w.word))
    list.value = senses
      .filter((s) => countOf.get(s.id) === 1 && !hidden.has(s.word))
      .map((s) => ({
        id: s.id,
        word: s.word,
        slot: s.slot,
        pos: s.pos,
        gloss: s.gloss,
      }))
      .sort((a, b) => a.word.localeCompare(b.word) || a.slot - b.slot)
    selected.value = list.value.map((s) => s.id)
  } catch (e) {
    toast(`读取单句义项失败：${e instanceof Error ? e.message : String(e)}`)
    list.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) void load()
  },
)

/** 页面被卸载时别让后台继续一个个烧请求；当前这一个等它回来就停。 */
onBeforeUnmount(() => {
  stopRequested.value = true
})

const canStart = computed(() => aiOn.value && selected.value.length > 0)
const percent = computed(() =>
  total.value ? Math.round((finished.value / total.value) * 100) : 0,
)

function isAdd(p: Proposal): p is AddProposal {
  return p.kind === 'sentence.add'
}

function fatal(e: unknown): boolean {
  if (!(e instanceof AiError)) return false
  if (e.kind === 'no-config') return true
  return (
    e.kind === 'http' &&
    (e.status === 401 || e.status === 402 || e.status === 403 || e.status === 429)
  )
}

async function startGen(): Promise<void> {
  if (!aiOn.value) {
    toast('先配置 AI：去「更多 → AI 助手」填 API Key')
    return
  }
  const targets = list.value.filter((s) => selected.value.includes(s.id))
  if (!targets.length) return
  queue.value = targets
  results.value = []
  problems.value = []
  excluded.value = new Set()
  finished.value = 0
  total.value = targets.length
  current.value = ''
  stopRequested.value = false
  stopped.value = false
  phase.value = 'gen'

  let networkFails = 0
  for (const target of targets) {
    if (stopRequested.value) {
      stopped.value = true
      break
    }
    current.value = `${target.word} · s${target.slot}`
    try {
      const r = await addSentence(target.id, HOW_MANY)
      const rows = await db.sentences.where('senseId').equals(target.id).toArray()
      const seen = new Set(rows.map((s) => s.en.trim().toLowerCase()))
      const fresh: AddProposal[] = []
      for (const p of r.proposals.filter(isAdd)) {
        if (p.senseId !== target.id) continue
        const key = p.en.trim().toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        fresh.push(p)
      }
      if (fresh.length) {
        results.value = [
          ...results.value,
          { target, proposals: fresh, cached: r.cached },
        ]
      } else {
        problems.value = [
          ...problems.value,
          { word: target.word, slot: target.slot, message: '没有新句（可能和已有例句重复）' },
        ]
      }
      networkFails = 0
    } catch (e) {
      problems.value = [
        ...problems.value,
        {
          word: target.word,
          slot: target.slot,
          message: describeAiError(e),
        },
      ]
      if (fatal(e)) {
        stopRequested.value = true
        stopped.value = true
      } else if (e instanceof AiError && e.kind === 'network') {
        networkFails++
        if (networkFails >= 2) {
          stopRequested.value = true
          stopped.value = true
        }
      } else {
        networkFails = 0
      }
    } finally {
      finished.value++
    }
  }
  current.value = ''
  phase.value = 'review'
}

function stopGen(): void {
  stopRequested.value = true
  stopped.value = true
}

function toggleGroup(id: string): void {
  const next = new Set(excluded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  excluded.value = next
}

const kept = computed(() => results.value.filter((r) => !excluded.value.has(r.target.id)))
const allGroupsSelected = computed(
  () => results.value.length > 0 && excluded.value.size === 0,
)
const keptSentences = computed(() =>
  kept.value.reduce((n, r) => n + r.proposals.length, 0),
)

function toggleAllGroups(): void {
  excluded.value = allGroupsSelected.value
    ? new Set(results.value.map((r) => r.target.id))
    : new Set()
}

function backToPick(): void {
  if (applying.value) return
  phase.value = 'pick'
  results.value = []
  problems.value = []
  excluded.value = new Set()
  stopped.value = false
  finished.value = 0
  total.value = 0
  void load()
}

async function applyConfirmed(): Promise<void> {
  if (applying.value || !kept.value.length) return
  applying.value = true
  try {
    const proposals = kept.value.flatMap((r) => r.proposals)
    const r = await applyAll(proposals)
    doneMessage.value = `已给 ${kept.value.length} 个义项补了 ${r.applied} 句例句。`
    phase.value = 'done'
    emit('changed')
  } catch (e) {
    doneMessage.value = `应用中断：${e instanceof Error ? e.message : String(e)}。已经应用的部分不会自动回滚，已存内容快照。`
    phase.value = 'done'
    emit('changed')
  } finally {
    applying.value = false
  }
}

function onClose(): void {
  if (phase.value === 'gen') {
    toast('正在生成，先点「停止」再关')
    return
  }
  emit('close')
}
</script>

<template>
  <Sheet
    :open="props.open"
    title="批量补例句"
    :badge="phase === 'pick' && list.length ? `${list.length} 个` : undefined"
    @close="onClose"
  >
    <p v-if="loading" class="loading"><van-loading size="20" /> 正在找只有 1 句的义项…</p>

    <template v-else-if="phase === 'pick'">
      <p v-if="!aiOn" class="warn">
        还没配置 AI。先去「更多 → AI 助手」填 API Key，再回来批量补。
      </p>
      <p v-else-if="!list.length" class="ok">没有只有 1 句可用例句的义项了。</p>
      <template v-else>
        <p class="hint">
          这些义项目前都只有 1 句。勾选后按顺序生成，<b>生成完先给你看，点应用才入库</b>。
          每个义项 1 次 AI 请求，随时可以停。
        </p>
        <div class="selbar">
          <span>已选 <b>{{ selected.length }}</b> / {{ list.length }}</span>
          <button class="lnk" type="button" @click="toggleAll">
            {{ allSelected ? '清空' : '全选' }}
          </button>
        </div>
        <div class="rows">
          <button
            v-for="s in list"
            :key="s.id"
            class="row"
            :class="{ on: isSelected(s.id) }"
            type="button"
            @click="toggle(s.id)"
          >
            <span class="box" />
            <span class="main">
              <span class="line1">
                <b>{{ s.word }}</b>
                <em>s{{ s.slot }}</em>
              </span>
              <span class="gloss">{{ s.gloss || '（缺释义）' }}</span>
            </span>
            <span class="count">1 句</span>
          </button>
        </div>
      </template>
    </template>

    <template v-else-if="phase === 'gen'">
      <div class="gen">
        <p class="genline">
          <b>{{ current || '准备中…' }}</b>
          <span>{{ finished }} / {{ total }}</span>
        </p>
        <van-progress :percentage="percent" :show-pivot="false" />
        <p class="hint">
          正在等待 AI。结果会先攒着，全部跑完（或你点停止）后统一检查，不会边跑边入库。
        </p>
        <p v-if="problems.length" class="warn">已有 {{ problems.length }} 个没生成成功，稍后会列出。</p>
      </div>
    </template>

    <template v-else-if="phase === 'review'">
      <p class="hint">
        <template v-if="stopped">已停止。已生成的部分还可以应用。</template>
        <template v-else>生成完成，还没有写入词库。</template>
        默认全选，取消勾选即可跳过整组；点底部「应用」才真正落库。
      </p>
      <div v-if="results.length" class="selbar">
        <span><b>{{ results.length }}</b> 个义项 · {{ keptSentences }} 句</span>
        <button class="lnk" type="button" @click="toggleAllGroups">
          {{ allGroupsSelected ? '全不选' : '全选' }}
        </button>
      </div>
      <div v-if="results.length" class="groups">
        <section
          v-for="g in results"
          :key="g.target.id"
          class="group"
          :class="{ off: excluded.has(g.target.id) }"
        >
          <button class="ghead" type="button" @click="toggleGroup(g.target.id)">
            <span class="box" />
            <span class="main">
              <span class="line1">
                <b>{{ g.target.word }}</b>
                <em>s{{ g.target.slot }}</em>
                <span v-if="g.cached" class="cache">缓存</span>
              </span>
              <span class="gloss">{{ g.target.gloss }}</span>
            </span>
            <span class="count">{{ g.proposals.length }} 句</span>
          </button>
          <ul v-if="!excluded.has(g.target.id)" class="sents">
            <li v-for="(p, i) in g.proposals" :key="p.id || i">
              <p class="en">{{ p.en }}</p>
              <p v-if="p.zh" class="zh">{{ p.zh }}</p>
            </li>
          </ul>
        </section>
      </div>
      <p v-else class="ok">这次没有生成可用的新例句。</p>

      <details v-if="problems.length" class="fails">
        <summary>{{ problems.length }} 个没生成成功</summary>
        <p v-for="(p, i) in problems" :key="i">{{ p.word }} · s{{ p.slot }}：{{ p.message }}</p>
      </details>
    </template>

    <template v-else>
      <p class="ok done">{{ doneMessage }}</p>
      <p class="hint">应用前已自动存内容快照；之后在义项页还能继续改或删。</p>
    </template>

    <template #footer>
      <template v-if="phase === 'pick'">
        <van-button
          block
          type="primary"
          :disabled="!canStart"
          @click="startGen"
        >
          开始生成 {{ selected.length }} 个
        </van-button>
      </template>
      <template v-else-if="phase === 'gen'">
        <van-button block plain type="danger" :disabled="stopRequested" @click="stopGen">
          {{ stopRequested ? '正在停下（等当前这句）' : '停止' }}
        </van-button>
      </template>
      <template v-else-if="phase === 'review'">
        <div class="fb">
          <van-button plain :disabled="applying" @click="backToPick">重选</van-button>
          <van-button
            type="primary"
            :disabled="!kept.length || applying"
            :loading="applying"
            @click="applyConfirmed"
          >
            应用 {{ keptSentences }} 句
          </van-button>
        </div>
      </template>
      <template v-else>
        <van-button block type="primary" @click="onClose">完成</van-button>
      </template>
    </template>
  </Sheet>
</template>

<style scoped>
.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--wb-ink-3);
  font-size: 13px;
}

.hint,
.warn,
.ok {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.65;
}

.hint,
.loading {
  color: var(--wb-ink-3);
}

.warn {
  color: #b26a00;
}

.ok {
  color: var(--wb-ink-2);
}

.done {
  font-size: 15px;
  font-weight: 600;
}

.selbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--wb-line);
  border-bottom: 1px solid var(--wb-line);
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.lnk {
  border: 0;
  background: transparent;
  padding: 2px 0;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--wb-primary);
  cursor: pointer;
}

.rows,
.groups {
  margin-top: 2px;
}

.row,
.ghead {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 2px;
  border: 0;
  border-bottom: 1px solid var(--wb-line);
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.row:active,
.ghead:active {
  background: var(--wb-bg);
}

.box {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  border: 1.5px solid var(--wb-line-2, #c9c9c9);
  border-radius: 5px;
  background: transparent;
}

.row.on .box,
.group:not(.off) .box {
  border-color: var(--wb-primary);
  background: var(--wb-primary);
  box-shadow: inset 0 0 0 3px var(--wb-bg);
}

.main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.line1 {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}

.line1 b {
  font-size: 15px;
  color: var(--wb-ink);
}

.line1 em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--wb-ink-3);
}

.cache {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--wb-bg);
  font-size: 10px;
  color: var(--wb-ink-3);
}

.gloss {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.count {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.sents {
  margin: 0;
  padding: 4px 0 10px 27px;
  list-style: none;
}

.sents li {
  padding: 5px 0;
  border-bottom: 1px dashed var(--wb-line);
}

.sents li:last-child {
  border-bottom: 0;
}

.en {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--wb-ink);
}

.zh {
  margin: 1px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-ink-3);
}

.group.off .main,
.group.off .count {
  opacity: 0.45;
}

.fails {
  margin-top: 12px;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.fails summary {
  cursor: pointer;
}

.fails p {
  margin: 5px 0;
  line-height: 1.5;
}

.genline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 8px;
  font-size: 13px;
}

.genline b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.genline span {
  flex: 0 0 auto;
  color: var(--wb-ink-3);
}

.fb {
  display: flex;
  gap: 8px;
  width: 100%;
}

.fb .van-button {
  flex: 1;
}
</style>
