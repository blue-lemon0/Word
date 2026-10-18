<script setup lang="ts">
/** AI 体检 —— 一次把全库过一遍，逐词看、逐词定。
 *
 *  ★ 为什么是一页而不是一个按钮跑完：体检的产出是**提议**，
 *    不是结果。自动应用等于把「内容对不对」这件事交给模型，
 *    而这个库是产品本体（复习计划全挂在它上面）。
 *    所以这一页的节奏是：跑一个词 → 摆出它的问题 → 你点应用或跳过 → 下一个。
 *
 *  ★ 为什么可以随时退出、再随时回来继续：结果按内容指纹缓存，
 *    跑过的词再进是 0 花费。这也是为什么这一页**不需要存档**：
 *    「进度」= 缓存里已经有的那些词。
 *
 *  ★ 为什么串行：并发请求会撞限流，也会让「第几个词」变得没法交代。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AiSheet from '../components/AiSheet.vue'
import { auditOne, auditTargets, lastAuditAt, markAudited, type AuditTarget } from '../ai/audit'
import { aiReady } from '../ai/config'
import { describeAiError, AiError, type AiResult } from '../ai/types'
import { goBack } from '../nav'
import { toast } from '../toast'

const router = useRouter()

const targets = ref<AuditTarget[]>([])
const idx = ref(0)
const running = ref(false)
const busy = ref(false)
const error = ref('')
const result = ref<AiResult | null>(null)
const sheetOpen = ref(false)
const stopRequested = ref(false)
const lastAt = ref(lastAuditAt())

type LogKind = 'ok' | 'clean' | 'skip' | 'error'
interface LogRow {
  word: string
  kind: LogKind
  note: string
}
const log = ref<LogRow[]>([])
const appliedTotal = ref(0)

const aiOn = aiReady
const current = computed(() => targets.value[idx.value])
const done = computed(() => idx.value >= targets.value.length && !sheetOpen.value)
const progress = computed(() =>
  targets.value.length ? Math.round((idx.value / targets.value.length) * 100) : 0,
)

onMounted(async () => {
  targets.value = await auditTargets()
})

const KIND_TEXT: Record<LogKind, string> = {
  ok: '已应用',
  clean: '没发现问题',
  skip: '跳过了',
  error: '出错',
}

function fmt(ts: number): string {
  if (!ts) return '还没跑过'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function start(): void {
  if (running.value || !targets.value.length) return
  running.value = true
  stopRequested.value = false
  idx.value = 0
  log.value = []
  appliedTotal.value = 0
  void step()
}

function stop(): void {
  stopRequested.value = true
  running.value = false
  toast('停下了；跑过的词已经缓存，下次不会再花钱')
}

async function step(): Promise<void> {
  if (!running.value || stopRequested.value) return
  const t = current.value
  if (!t) {
    finish()
    return
  }
  busy.value = true
  error.value = ''
  try {
    const r = await auditOne(t.word)
    busy.value = false
    if (!r.proposals.length) {
      log.value.unshift({ word: t.word, kind: 'clean', note: r.note })
      advance()
      return
    }
    result.value = r
    sheetOpen.value = true
  } catch (e) {
    busy.value = false
    error.value = describeAiError(e)
    log.value.unshift({ word: t.word, kind: 'error', note: error.value })
    // 一个词的回复坏了不该让整轮白跑；限流/没余额/网络断了才停。
    const wordLevel = e instanceof AiError && (e.kind === 'parse' || e.kind === 'refused')
    if (wordLevel) {
      advance()
      return
    }
    running.value = false
    markAudited()
    lastAt.value = lastAuditAt()
  }
}

/** 下一个词。用微任务排队，避免递归把调用栈越堆越深（几十个词就会很明显）。 */
function advance(): void {
  if (!running.value) return
  idx.value++
  queueMicrotask(() => void step())
}

function onSheetClose(): void {
  // 应用之后父组件已经把 sheetOpen 置 false；此时 van-popup 自己还会补一次关闭事件，
  // 那一次不该再推进队列（否则会跳过一整词）
  if (!sheetOpen.value) return
  sheetOpen.value = false
  result.value = null
  if (!running.value) return
  log.value.unshift({ word: current.value?.word ?? '（未知）', kind: 'skip', note: '' })
  advance()
}

function onApplied(n: number): void {
  sheetOpen.value = false
  appliedTotal.value += n
  log.value.unshift({ word: current.value?.word ?? '（未知）', kind: 'ok', note: `${n} 条` })
  result.value = null
  advance()
}

function finish(): void {
  running.value = false
  markAudited()
  lastAt.value = lastAuditAt()
  toast(`体检完了：${appliedTotal.value} 条已应用`)
}
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <van-icon name="arrow-left" size="18" @click="goBack(router, '/more')" />
        <h1>AI 体检</h1>
        <span class="wb-sp" />
        <van-button v-if="running" size="mini" plain type="danger" @click="stop">停止</van-button>
      </div>
    </header>

    <div class="wb-wrap">
      <section class="wb-card intro">
        <p class="lead">
          逐个词让 AI 看一遍：释义准不准、例句是不是真的在教这个意思、音标有没有缺、
          哪个义项是熟词僻义。<b>一次只跑一个词，结果由你定。</b>
        </p>
        <div class="facts">
          <div><b>{{ targets.length }}</b><span>个词</span></div>
          <div><b>{{ idx }}</b><span>已过</span></div>
          <div><b>{{ appliedTotal }}</b><span>条已应用</span></div>
        </div>
        <p class="dim">
          上次体检：{{ fmt(lastAt) }} · 跑过的词结果会缓存，内容没变再跑不花钱
        </p>

        <p v-if="!aiOn" class="warn">先去「更多 → AI 助手」填 Key 才能体检。</p>

        <div class="acts">
          <van-button
            v-if="!running"
            type="primary"
            round
            block
            :disabled="!aiOn || !targets.length"
            @click="start"
          >
            {{ idx || appliedTotal ? '再跑一遍（只跑没缓存的）' : '开始体检' }}
          </van-button>
          <van-button v-else plain round block disabled>
            {{ busy ? `正在看：${current?.word ?? ''}…` : '继续中…' }}
          </van-button>
        </div>

        <div v-if="running || idx" class="bar">
          <div class="barin" :style="{ width: progress + '%' }" />
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <p v-if="done && !running" class="okline">这一轮过完了。</p>
      </section>

      <section v-if="log.length" class="wb-card">
        <h3 class="hd">这一轮的记录</h3>
        <ul class="log">
          <li v-for="(row, i) in log" :key="i" :class="row.kind">
            <b>{{ row.word }}</b>
            <span class="k">{{ KIND_TEXT[row.kind] }}</span>
            <span v-if="row.note" class="n">{{ row.note }}</span>
          </li>
        </ul>
      </section>
    </div>

    <AiSheet
      :show="sheetOpen"
      :result="result"
      :busy="false"
      :error="''"
      :label="current?.word"
      @close="onSheetClose"
      @applied="onApplied"
    />
  </div>
</template>

<style scoped>
.intro .lead {
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--wb-ink-2);
}

.facts {
  display: flex;
  gap: 10px;
  margin: 14px 0 8px;
}

.facts > div {
  flex: 1 1 0;
  background: var(--wb-bg);
  border-radius: 12px;
  padding: 10px;
  text-align: center;
}

.facts b {
  display: block;
  font-size: 20px;
  font-weight: 650;
}

.facts span {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.dim {
  font-size: 12px;
  line-height: 1.7;
  color: var(--wb-ink-3);
  margin: 6px 0 12px;
}

.warn {
  font-size: 12.5px;
  color: #9a6400;
  background: #fff6e6;
  border-radius: 10px;
  padding: 8px 10px;
  margin-bottom: 10px;
}

.err {
  margin-top: 10px;
  font-size: 12.5px;
  color: #c0392b;
}

.okline {
  margin-top: 10px;
  font-size: 12.5px;
  color: #1e8e5a;
}

.acts {
  margin-top: 6px;
}

.bar {
  margin-top: 12px;
  height: 4px;
  border-radius: 2px;
  background: var(--wb-line);
  overflow: hidden;
}

.barin {
  height: 100%;
  background: var(--primary);
  transition: width 0.2s;
}

.hd {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}

.log {
  list-style: none;
  margin: 0;
  padding: 0;
}

.log li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--wb-line);
  font-size: 13px;
}

.log li:last-child {
  border-bottom: 0;
}

.log b {
  font-weight: 600;
  min-width: 5.5em;
}

.log .k {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.log li.ok .k {
  color: #1e8e5a;
}

.log li.error .k {
  color: #c0392b;
}

.log .n {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
