<script setup lang="ts">
/**
 * 扫读 —— 像看报纸一样扫例句，看不懂哪句就点哪句。
 *
 *  为什么要有它：前两种练法都是「一轮 20 题、按顺序、答完即止」。
 *  但背单词真正发生的那一下，常常不是「轮到我了」，
 *  而是**扫到某一句、没看懂、想查一下**。那条路径之前不存在 ——
 *  想练只能从到期队列里排队，或者从词库/错题板里翻。
 *
 *  三条设计约束（都是这条模式成立的前提）：
 *   1. **混词不排序**。同一屏里出现 14 个不同的词，才有「扫」的感觉；
 *      同一个词不连着出两条（`scanBatch` 里限了），否则像卡住了。
 *   2. **不显示中文**。扫的时候就要能扫，中文一露出来就成了对照表。
 *      中文在点进去答题之后才出现（和训练页同一套口径：出题时露 = 泄题）。
 *   3. **点哪句就是哪句**。必须把那一行的 `sentenceId` 一起带过去
 *      （`makeQuestion(senseId, pinSentence)`），否则随机到别的句子，
 *      用户会觉得「我点的不是它」。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import MarkedText from '../components/MarkedText.vue'
import { scanBatch, type ScanItem } from '../quiz'

const router = useRouter()

const items = ref<ScanItem[]>([])
const loading = ref(true)

/** 换一批：跳过上一个批次出现过的词，避免「换个顺序」其实是同一屏 */
let lastWords = ''

async function load(): Promise<void> {
  loading.value = true
  const rows = await scanBatch(14, undefined, lastWords)
  lastWords = rows.map((r) => r.sense.word).join(',')
  items.value = rows
  loading.value = false
}

/** 点哪句猜哪句 */
function drill(it: ScanItem): void {
  router.push({
    path: '/train',
    query: { solo: it.sense.id, sent: String(it.sentence.id) },
  })
}

onMounted(load)
</script>

<template>
  <div class="wb-page">
    <header class="wb-topbar">
      <div class="in">
        <van-icon name="arrow-left" size="18" @click="router.back()" />
        <h1>扫读</h1>
        <van-button size="mini" plain @click="load">换一批</van-button>
      </div>
    </header>

    <div class="wb-wrap">
      <p class="lead">
        像看报纸一样扫。哪句看不懂就点哪句，只练那一句。
        <span class="wb-dim">这里不显示中文 —— 中文在答题之后才出现。</span>
      </p>

      <p v-if="loading" class="ld">正在挑句子…</p>
      <p v-else-if="!items.length" class="empty">
        例句还太少，扫不出东西。先去「词库 → 导入」一份内容包。
      </p>

      <div v-else class="paper">
        <button v-for="(it, i) in items" :key="it.sentence.id" class="line" @click="drill(it)">
          <span class="n">{{ i + 1 }}</span>
          <MarkedText
            class="tx"
            :text="it.sentence.en"
            :form="it.sentence.form"
            :span-start="it.sentence.spanStart"
            :span-len="it.sentence.spanLen"
          />
          <span v-if="it.sense.pos" class="pos">{{ it.sense.pos }}</span>
        </button>
      </div>

      <van-button v-if="items.length" class="more" block plain @click="load">
        换一批
      </van-button>
    </div>
  </div>
</template>

<style scoped>
.lead {
  font-size: 12.5px;
  color: var(--wb-ink-2);
  line-height: 1.6;
  margin: 10px 2px 12px;
}

.ld,
.empty {
  font-size: 13px;
  color: var(--wb-ink-3);
  padding: 40px 0;
  text-align: center;
}

/* 报纸感的关键：整块纸、细横线分隔、左边一列序号做「行号」，
   每行高度按内容自然涨（不裁剪），眼睛可以像读报一样往下扫。 */
.paper {
  background: var(--wb-card);
  border-radius: var(--wb-radius);
  overflow: hidden;
}

.line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
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

/* 行号：灰、小、等宽 —— 它是版面上的「行号」，不是内容的序号 */
.n {
  flex: 0 0 auto;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  color: var(--wb-ink-3);
  padding-top: 2px;
  min-width: 16px;
  text-align: right;
}

.tx {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14.5px;
  line-height: 1.55;
}

.pos {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
  padding-top: 2px;
}

.more {
  margin-top: 12px;
}
</style>