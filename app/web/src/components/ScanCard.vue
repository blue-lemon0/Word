<script setup lang="ts">
/**
 * 扫读卡 —— 混在「随便刷」队列里的插入卡（抖音信息流里的直播/广告位）。
 *
 *  一张卡 3 句，每句的目标词**不同**：先只给英文 + 高亮目标词，
 *  让人心里猜这个词在这儿是什么意思；点句子翻开中文翻译 + 目标词释义，
 *  然后自评 —— 猜对打勾、猜错打叉。
 *
 *  ★ 勾/叉走 recordScanVerdict 落 SRS，与选项作答同一条链路：
 *    没到期就打勾，增长被提前复习折扣自动打到接近零，不需要额外防刷。
 *  ★ 外壳（首页）按页存了已评结果（marks prop），窗口式渲染卸载再挂回时
 *    靠它恢复原样 —— 不然已评的句又能再点，SRS 被记两遍（与 QuestionBox
 *    的 answered prop 同一个坑的同一味药）。
 *  ★ 已评锁定，不许改：改一口就是第二次 recordAnswer。点错的代价是
 *    一条 SRS 记录，认了，下一张卡见。
 *  ★ 没有自动播放：一屏三句，不知道播哪句；喇叭留给用户手动点。
 */
import { reactive, watch } from 'vue'
import MarkedText from './MarkedText.vue'
import { newSessionId, recordScanVerdict, type ScanItem } from '../quiz'
import { speakEn, speechOn, ttsWaiting } from '../speech'

const props = defineProps<{
  items: ScanItem[]
  /** 外壳按页存下的已评结果：重挂时恢复，已评的句不许再评（SRS 不记两遍） */
  marks?: Array<'CORRECT' | 'WRONG' | null>
}>()

const emit = defineEmits<{
  /** 状态变化：外壳用它切底栏。扫读卡挂载即 revealed —— 它没有「显示选项」阶段 */
  (e: 'state', s: { revealed: boolean; submitted: boolean }): void
  /** 一句评完：外壳计数（对 / 已答）并按页存盘 */
  (e: 'verdict', v: { index: number; result: 'CORRECT' | 'WRONG' }): void
  /** 翻开后点句子里的词：外壳开查词浮层（翻开前整行都是「点开对答案」，不拆词） */
  (e: 'pick', w: string): void
  /** 点释义行的词头：跳词条页 */
  (e: 'word', w: string): void
}>()

/** 每句的状态：opened = 已翻开对答案；marked = 已自评（锁定） */
interface Row {
  opened: boolean
  marked: 'CORRECT' | 'WRONG' | null
}

const rows = reactive<Row[]>(
  props.items.map((_, i) => {
    const m = props.marks?.[i] ?? null
    return { opened: !!m, marked: m }
  }),
)

const session = newSessionId()

function open(i: number): void {
  const r = rows[i]
  if (!r || r.opened) return
  r.opened = true
}

function mark(i: number, result: 'CORRECT' | 'WRONG'): void {
  const r = rows[i]
  const it = props.items[i]
  if (!r || !it || !r.opened || r.marked) return
  r.marked = result
  emit('verdict', { index: i, result })
  void recordScanVerdict(it, result, session, i)
}

/* 挂载即报一次状态（immediate）：扫读卡没有「显示选项」阶段，
   底栏直接落「点句子翻开对答案」分支；全评完落「上一题 / 下一题」。 */
watch(
  () => rows.every((x) => x.marked),
  (all) => emit('state', { revealed: true, submitted: all }),
  { immediate: true },
)
</script>

<template>
  <div class="scard">
    <header class="shead">
      <span class="stag">扫读</span>
      <span class="stip">先心里猜，点句子翻开对答案</span>
      <span class="wb-sp" />
      <span class="sprog">{{ rows.filter((r) => r.marked).length }} / {{ items.length }}</span>
    </header>

    <div v-for="(it, i) in items" :key="it.sentence.id" class="srow">
      <div class="sline">
        <button class="sen" type="button" @click="open(i)">
          <MarkedText
            :text="it.sentence.en"
            :marks="it.sentence.marks"
            :form="it.sentence.form"
            :span-start="it.sentence.spanStart"
            :span-len="it.sentence.spanLen"
            :pickable="rows[i].opened"
            @pick="(w: string) => emit('pick', w)"
          />
        </button>
        <button
          v-if="speechOn"
          class="wb-say"
          :class="{ waiting: ttsWaiting }"
          type="button"
          aria-label="朗读例句"
          @click.stop="speakEn(it.sentence.en)"
        >
          <van-icon name="volume-o" />
        </button>
      </div>

      <template v-if="rows[i].opened">
        <p v-if="it.sentence.zh" class="szh">{{ it.sentence.zh }}</p>
        <button class="sgloss" type="button" @click="emit('word', it.sense.word)">
          <b>{{ it.sense.word }}</b>
          <span v-if="it.sense.pos" class="spos">{{ it.sense.pos }}</span>
          <span class="sg">{{ it.sense.gloss }}</span>
          <span class="sgo">词条 ›</span>
        </button>
        <div v-if="!rows[i].marked" class="smark">
          <button class="sm ok" type="button" @click="mark(i, 'CORRECT')">✓ 猜对了</button>
          <button class="sm no" type="button" @click="mark(i, 'WRONG')">✗ 没猜对</button>
        </div>
        <p v-else class="sres" :class="rows[i].marked === 'CORRECT' ? 'ok' : 'no'">
          {{ rows[i].marked === 'CORRECT' ? '✓ 猜对了' : '✗ 没猜对' }}
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 卡片自成一体（不借外壳的 .qcard）：它会被装进首页的 .qcenter，
   内容高了由自己限高、内部滚 */
.scard {
  width: 100%;
  max-height: 100%;
  overflow-y: auto;
  background: var(--wb-card);
  border: 1px solid var(--wb-line);
  border-radius: 16px;
  padding: 12px 14px;
  box-shadow: 0 1px 2px rgba(31, 35, 51, 0.03);
}

.shead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

/* 内容类型标签 —— 像抖音信息流里「广告」「直播」的小标，
   让人一眼知道这张卡和单题不一样 */
.stag {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--wb-primary);
  border: 1px solid var(--wb-primary);
  border-radius: 6px;
  padding: 0 6px;
}

.stip {
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.sprog {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
  font-variant-numeric: tabular-nums;
}

.srow {
  border-top: 1px solid var(--wb-line);
  padding: 10px 0;
}

.srow:first-of-type {
  border-top: 0;
}

.sline {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.sen {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: 15.5px;
  line-height: 1.6;
  text-align: left;
  color: var(--wb-ink);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.sline .wb-say {
  flex: 0 0 auto;
  margin-top: 1px;
}

.szh {
  margin-top: 6px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

/* 释义行：整行可点跳词条页 */
.sgloss {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  margin-top: 8px;
  background: var(--wb-bg);
  border: 0;
  border-radius: 10px;
  padding: 8px 10px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.sgloss b {
  font-size: 14px;
}

.spos {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

.sg {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--wb-ink);
}

.sgo {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--wb-ink-3);
}

/* 自评按钮：与 QuestionBox 的对/错同一组色 */
.smark {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.sm {
  flex: 1;
  padding: 9px 10px;
  border-radius: 12px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
}

.sm.ok {
  color: #12a05c;
  border-color: #12a05c;
  background: #f0fbf5;
}

.sm.no {
  color: #d24b3e;
  border-color: #d24b3e;
  background: #fdf1f0;
}

.sres {
  margin-top: 10px;
  font-size: 13px;
}

.sres.ok {
  color: #12a05c;
}

.sres.no {
  color: #d24b3e;
}
</style>
