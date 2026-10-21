<script setup lang="ts">
/** AI 提议浮层 —— 只负责「把 AI 想改什么摆出来，让人挑」。
 *
 *  ★ 为什么必须是「提议 → 应用」而不是直接改库：
 *    内容是这套系统的本体（词库不是缓存）。AI 会自信地改错，
 *    而一次错误的释义修订会污染练习、又很难被发现。
 *    所以每一条都要能看见**改前 → 改后**，并且可以单条忽略。
 *
 *  ★ 为什么用一张浮层承载所有 AI 动作：
 *    「审查 / 补一句 / 换一句」产出的东西是同一种（提案列表），
 *    界面就没必要分三套。动作只在标题和空态话术上有区别。
 *
 *  ★ 事件只有两个，而且**互斥**：`applied(n)` 与 `close`。
 *    早先的写法是「应用之后再发一次 close」，结果调用方收到两次「这次结束了」：
 *    体检那边因此把队列推进两格（跳过一个词），日志里还多出一条没有词名的记录。
 *    现在应用只发 `applied` —— 关不关浮层、要不要继续，是调用方的事。
 */
import { computed, ref, watch } from 'vue'
import { applyAll, applyOne } from '../ai/apply'
import type { Proposal, AiResult } from '../ai/types'
import { toast } from '../toast'

const props = defineProps<{
  show: boolean
  result: AiResult | null
  busy: boolean
  error: string
  /** 附在标题后面的说明（体检时用来指出「现在审的是哪个词」） */
  label?: string
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'applied', count: number): void }>()

/** 被忽略的提案（按 id）；「全部应用」只应用剩下的 */
const skipped = ref<Set<string>>(new Set())
const applying = ref(false)

const title = computed(() => {
  if (props.error) return 'AI 这边出了点问题'
  switch (props.result?.action) {
    case 'addSentence':
      return 'AI 补的例句'
    case 'replaceSentence':
      return 'AI 换这一句'
    case 'reviewWord':
      return 'AI 审查结果'
    case 'fillWord':
      return 'AI 补全这个词'
    default:
      return 'AI'
  }
})

const kindLabel: Record<Proposal['kind'], string> = {
  'sense.update': '改释义',
  'word.update': '补音标',
  'sentence.replace': '换例句',
  'sentence.add': '加例句',
  'sense.add': '加义项',
}

function isSkipped(p: Proposal): boolean {
  return skipped.value.has(p.id)
}

function toggle(p: Proposal): void {
  const s = new Set(skipped.value)
  if (s.has(p.id)) s.delete(p.id)
  else s.add(p.id)
  skipped.value = s
}

const kept = computed(() => (props.result?.proposals ?? []).filter((p) => !isSkipped(p)))

/** 改前 → 改后。改前从「当时的上下文」里取 —— 由 actions 带回来太重，
 *  这里只显示 AI 给的新值 + 原因；真正的「改前」在点应用之前由界面上的
 *  「看原文」承担（同一句话在词条页上一眼就能看到）。 */
function lineOf(p: Proposal): { label: string; to: string; why: string } {
  switch (p.kind) {
    case 'sense.update':
      return {
        label: `s${p.slot} 释义`,
        to:
          ([p.pos, p.gloss].filter(Boolean).join(' ') ||
            (p.trap != null ? (p.trap ? '标成「熟词僻义」' : '取消「熟词僻义」') : '（只改备注/英文）')) +
          (p.sentences?.length ? `\n＋ ${p.sentences.length} 句例句` : ''),
        why: p.why ?? '',
      }
    case 'word.update':
      return { label: '音标', to: `/${p.ipa}/`, why: p.why ?? '' }
    case 'sentence.replace':
      return { label: p.label, to: p.en, why: p.why ?? '' }
    case 'sentence.add':
      return { label: p.label, to: p.en, why: p.why ?? '' }
    case 'sense.add':
      return {
        label: '新增义项',
        to:
          [p.pos, p.gloss].filter(Boolean).join(' ') +
          (p.sentences?.length ? `\n＋ ${p.sentences.length} 句例句` : ''),
        why: p.why ?? '',
      }
  }
}

/** 防止「应用」之后再补一个 close。
 *
 *  ★ 真实的机制：应用之后父组件把 `show` 置 false → van-popup 自己也走一遍关闭流程
 *    并 emit close → 调用方又收到一次「这次结束了」。体检那边因此把队列推两格
 *    （跳过一整词），日志里还多一条没有词名的记录。
 *    所以「应用」一旦发生，就把这一次关闭事件吃掉。
 */
let appliedFired = false

watch(
  () => props.show,
  (v) => {
    if (v) appliedFired = false
  },
)

function onPopupClose(): void {
  if (appliedFired) {
    appliedFired = false
    return
  }
  emit('close')
}

async function applyOneNow(p: Proposal): Promise<void> {
  if (applying.value) return
  applying.value = true
  try {
    const msg = await applyOne(p)
    toast(msg)
    appliedFired = true
    emit('applied', 1)
  } catch (e) {
    toast(`应用失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    applying.value = false
  }
}

async function applyKept(): Promise<void> {
  if (applying.value || !kept.value.length) return
  applying.value = true
  try {
    const n = kept.value.length
    const r = await applyAll(kept.value)
    toast(`已应用 ${r.applied} 条（应用前自动存了快照）`)
    appliedFired = true
    emit('applied', r.applied || n)
  } catch (e) {
    toast(`应用失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <van-popup
    :show="show"
    position="bottom"
    round
    close-on-popstate
    :style="{ maxHeight: '88vh' }"
    @close="onPopupClose"
  >
    <div class="ai">
      <header class="hd">
        <h3>{{ title }}</h3>
        <span v-if="label" class="who">{{ label }}</span>
        <span v-if="result?.cached" class="badge">缓存（这次没花钱）</span>
      </header>

      <p v-if="busy" class="lead">AI 正在看…（一次请求，等几秒）</p>
      <p v-else-if="error" class="lead err">{{ error }}</p>

      <template v-else-if="result">
        <p v-if="result.note && result.note !== 'ok'" class="lead">{{ result.note }}</p>
        <p v-if="!result.proposals.length" class="lead ok">没发现问题，一个字都没改。</p>

        <ul v-else class="list">
          <li
            v-for="p in result.proposals"
            :key="p.id"
            class="row"
            :class="{ off: isSkipped(p) }"
          >
            <div class="top">
              <span class="tagk">{{ kindLabel[p.kind] }}</span>
              <span class="where">{{ lineOf(p).label }}</span>
              <span class="wb-sp" />
              <button class="mini" type="button" @click="toggle(p)">
                {{ isSkipped(p) ? '保留' : '忽略' }}
              </button>
            </div>
            <p class="to">{{ lineOf(p).to }}</p>
            <!-- 新义项自带的例句：直接把句子摆出来。
                 这一条是「补全一个空壳词」的主内容 —— 只写「＋2 句例句」
                 等于让人盲签：句子是最后要背的东西，必须能先看见。 -->
            <ul
              v-if="(p.kind === 'sense.add' || p.kind === 'sense.update') && p.sentences?.length"
              class="sents"
            >
              <li v-for="(s, i) in p.sentences" :key="i">
                <b>{{ s.en }}</b>
                <span v-if="s.zh">{{ s.zh }}</span>
              </li>
            </ul>
            <p v-if="lineOf(p).why" class="why">{{ lineOf(p).why }}</p>
            <button class="applyOne" type="button" @click="applyOneNow(p)">只应用这条</button>
          </li>
        </ul>

        <p v-if="result.usage" class="meta">
          这次用了 {{ result.usage.total }} tokens（输入 {{ result.usage.prompt }} / 输出
          {{ result.usage.completion }}）
        </p>

        <div class="acts">
          <van-button block @click="$emit('close')">先不动</van-button>
          <van-button
            block
            type="primary"
            :disabled="!kept.length || applying"
            @click="applyKept"
          >
            应用 {{ kept.length }} 条
          </van-button>
        </div>
      </template>
    </div>
  </van-popup>
</template>

<style scoped>
.ai {
  padding: 16px 16px calc(14px + env(safe-area-inset-bottom, 0px));
  overflow: auto;
  max-height: calc(88vh - 8px);
}

.hd {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hd h3 {
  font-size: 16.5px;
  font-weight: 650;
}

.badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--wb-line);
  color: var(--wb-ink-3);
}

.hd .who {
  font-size: 12.5px;
  color: var(--wb-ink-3);
}

.lead {
  margin: 12px 0;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.lead.err {
  color: #c0392b;
}

.lead.ok {
  color: #1e8e5a;
}

.list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}

.row {
  border: 1px solid var(--wb-line);
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: var(--wb-card);
}

.row.off {
  opacity: 0.45;
}

.top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tagk {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--primary-soft);
  color: var(--primary);
}

.where {
  font-size: 12px;
  color: var(--wb-ink-3);
}

.mini {
  border: 1px solid var(--wb-line);
  background: transparent;
  border-radius: 999px;
  font-family: inherit;
  font-size: 11.5px;
  padding: 2px 9px;
  color: var(--wb-ink-3);
  cursor: pointer;
}

.to {
  margin-top: 8px;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--wb-ink);
  word-break: break-word;
}

.why {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}

.sents {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.sents li {
  border-left: 2px solid var(--wb-line);
  padding-left: 9px;
  margin-bottom: 8px;
  font-size: 13.5px;
  line-height: 1.6;
}

.sents li b {
  display: block;
  font-weight: 500;
  color: var(--wb-ink);
}

.sents li span {
  color: var(--wb-ink-3);
  font-size: 12.5px;
}

.applyOne {
  margin-top: 8px;
  border: 0;
  background: transparent;
  color: var(--primary);
  font-family: inherit;
  font-size: 12.5px;
  padding: 0;
  cursor: pointer;
}

.meta {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.acts {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
</style>
