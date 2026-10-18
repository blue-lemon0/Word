<script setup lang="ts">
/**
 * 扫读例句列表 —— 报纸式的一栏例句，点哪句练哪句。
 *
 * ★ 为什么它是「一个组件」而不是「一个页面」：
 *   封装上它自成一体（自己取句子、自己换一批、自己管空/加载态），
 *   但显示上它**长在训练页下面** —— 用户滚一屏就能同时看到
 *   「今天练什么」和「随手扫两句」，而不是「训练 / 扫读」两个整屏来回切。
 *   之前它是 `mode === 'scan'` 独占整屏的，代价是：进扫读就把训练入口顶掉，
 *   看着像另一个页面，而且想回去得先记住「返回在哪」。
 *
 * ★ 「换一批」放在标题右边，不放在列表末尾：
 *   放末尾时它的位置 = 列表高度，「换一批」行数一变按钮就上下跳，
 *   手指正要按的位置已经不是按钮了（真机反馈：刷新时按钮会抖）。
 *   放在标题行 → 位置只跟标题有关，跟列表多长无关。
 */
import { onMounted, ref } from 'vue'
import MarkedText from './MarkedText.vue'
import { scanBatch, type ScanItem } from '../quiz'

/** 点一行 → 交给父组件弹「这一句什么意思」（不再直接进答题，见 ScanPeek） */
const emit = defineEmits<{ (e: 'pick', item: ScanItem): void }>()

const BATCH = 14

const items = ref<ScanItem[]>([])
const loading = ref(false)
const skip = ref('')

async function load(): Promise<void> {
  loading.value = true
  try {
    items.value = await scanBatch(BATCH, undefined, skip.value)
  } finally {
    loading.value = false
  }
}

async function nextBatch(): Promise<void> {
  // 从上一批**最后一个词**之后接着取 —— 不重复、不漏。
  // 用整个词的集合当 skip 太贪心（会把还没轮到的句子也跳掉），
  // 用「这一批出现过的全部词」又太宽松（连着点两次可能还是同一批）。
  const last = items.value[items.value.length - 1]
  skip.value = last?.sense.word ?? ''
  await load()
}

onMounted(load)
</script>

<template>
  <section class="scan">
    <header class="head">
      <h2>
        <span class="t">
          扫读例句
          <span v-if="items.length" class="cnt">{{ items.length }} 句</span>
        </span>
        <span class="wb-dim">不懂哪句点哪句，只练那一句</span>
      </h2>
      <button class="again" type="button" :disabled="loading" @click="nextBatch">换一批</button>
    </header>

    <p v-if="loading" class="lead">正在挑句子…</p>
    <p v-else-if="!items.length" class="lead">
      例句还太少，扫不出东西。先去「词库 → 导入」一份内容包。
    </p>

    <div v-else class="paper">
      <button v-for="(it, i) in items" :key="it.sentence.id" class="line" @click="emit('pick', it)">
        <span class="n">{{ i + 1 }}</span>
        <span class="tx">
          <MarkedText
            :text="it.sentence.en"
            :form="it.sentence.form"
            :span-start="it.sentence.spanStart"
            :span-len="it.sentence.spanLen"
          />
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.scan {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--wb-line);
}

/* ★ 标题栏吸顶：句子列表会很长，「扫读例句 / 换一批」不该被滚出屏幕。
   注意挂的是真正的类名 .head（不是 .hd）—— 挂错类名时 sticky 完全不生效，
   而且没有任何报错，只是行为没发生。 */
.head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--wb-bg);
  padding-bottom: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.head h2 .t {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}

.head h2 {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 15px;
  font-weight: 600;
}

.head h2 .wb-dim {
  font-size: 12px;
  font-weight: 400;
}

.cnt {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  color: var(--wb-ink-3);
  font-variant-numeric: tabular-nums;
}

.again {
  flex: 0 0 auto;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  color: var(--wb-ink-2);
  font-size: 12.5px;
  padding: 6px 12px;
  border-radius: 999px;
  font-family: inherit;
  cursor: pointer;
}

.again:active {
  background: var(--wb-bg);
}

.lead {
  margin-top: 10px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-3);
}

/* ── 报纸感：整块纸、细横线、左边一列行号。
   ★ 句子后面**不挂词性标签**（n. / v. / adj. …）：真实语料里的句子不长那样，
     挂上去就成了「词典 app 的句子」而不是「一句真话」。要查词性点进单题，
     那里本来就有。所见即真实 —— 这一栏唯一的任务就是让人像读报一样扫下去。
   ★ 对齐：行号/句子**共用同一个行高**（--scan-lh）+ flex-start 顶部对齐。
     一开始是 align-items: baseline，但 `.tx` 是组件，基线取决于它内部第一个
     行盒落在哪；一旦它包了一层 block，基线就不是第一行文字的基线了。
     行高相同 + 顶部对齐是不依赖内部结构的确定解：盒子等高，基线自然齐平。 ── */
.paper {
  --scan-lh: 22.5px;
  margin-top: 10px;
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  overflow: hidden;
}

.line {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--wb-line);
  background: transparent;
  padding: 11px 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.line:last-child {
  border-bottom: 0;
}

.line:active {
  background: var(--wb-bg);
}

/* 行号：灰、小、等宽 —— 它是版面的一部分，不是内容的序号 */
.n {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: var(--scan-lh);
  font-family: ui-monospace, monospace;
  color: var(--wb-ink-3);
  text-align: right;
  min-width: 15px;
}

.tx {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14.5px;
  line-height: var(--scan-lh);
}
</style>