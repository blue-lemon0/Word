<script setup lang="ts">
/** 一道题 —— 只负责「题干 + 选项 + 判分 + 解析」，不管外壳。
 *
 *  ★ 抽出来的理由：这道题原来有两处实现（训练页一整屏、练习浮层一层），
 *    两处迟早会走样。现在只有这一份，装进浮层就是「练一句」，
 *    装进首页的练习副页就是「连练」，判分链路完全一致（makeQuestion → recordAnswer）。
 *
 *  ★ 它**不自带底部按钮**：浮层里是「继续扫 / 再练一次」，副页里是「下一题」,
 *    那是外壳的事。组件只管把这一道题摆清楚、判完、给出解析。
 */
import { ref, watch } from 'vue'
import MarkedText from './MarkedText.vue'
import { db } from '../db'
import { dueInText } from '../composables'
import { formsOfSentence } from '../marks'
import { makeQuestion, newSessionId, recordAnswer, type Question } from '../quiz'
import { speakEn, speechOn, ttsWaiting } from '../speech'
import { toast } from '../toast'
import type { Sentence } from '../types'

const props = defineProps<{
  /** true = 不自带「我不会 / 显示选项」，由外壳固定底栏渲染（首页屏一用） */
  hideActions?: boolean
  /** true = 卡片底栏不显示「对了/错了 · 下次」结果（首页只要动作，不要状态） */
  hideResult?: boolean
  /** true = 作答后句子里的词可点开（查义） */
  allowPick?: boolean
  senseId: string
  /** 钉住哪一句（扫读点的那句）。不给就随机 */
  sentenceId?: number
  /** 序号，让组件知道「换题了」（同一 sense 连练两句时也要重开） */
  serial?: number
  /** 外壳预取好的题（坑 78：快速翻页时再现场出题 = 每页都先亮一个「出题…」
   *  空壳。给了它就直接用，不走 makeQuestion；reload(force) 可绕过） */
  question?: Question
  /** 外壳记下的作答结果（首页窗口式渲染会卸载远处的页）。
   *  不传的话，翻远再翻回来这一题会变回「没答过」—— 再点一次就是
   *  第二次 recordAnswer，SRS 被记两遍，而界面上看不出来。 */
  answered?: {
    result: 'CORRECT' | 'WRONG' | 'PENDING'
    picked: string
    outcome?: Question['outcome']
  } | null
}>()

const emit = defineEmits<{
  (e: 'word', w: string): void
  (e: 'answered', a: {
    result: 'CORRECT' | 'WRONG' | 'PENDING'
    picked: string
    outcome?: Question['outcome']
  }): void
  (e: 'loaded', q: Question): void
  /** 状态变化：外壳用它在「我不会/显示选项」与「下一题」之间切换 */
  (e: 'state', s: { revealed: boolean; submitted: boolean }): void
  /** 作答后点句子里的某个词（外壳拿它开查义浮层） */
  (e: 'pick', w: string): void
}>()

const KEYS = ['A', 'B', 'C', 'D']

const q = ref<Question | null>(null)
const revealed = ref(false)
const picked = ref('')
const submitted = ref(false)
/** 作答后默认停在题面（句子 + 选项），只切换「其它例句」——
 *  切换是单纯的显示隐藏：例句视图里句子和选项一起收起。 */
const view = ref<'question' | 'examples'>('question')
const busy = ref(false)
const err = ref('')
const others = ref<Sentence[]>([])
const session = newSessionId()
const shownAt = ref(0)

const isRight = (opt: string): boolean => !!q.value && opt === q.value.sense.gloss

function nextText(): string {
  const due = q.value?.outcome?.dueAt
  return due == null ? '' : dueInText(due)
}

const resultText = ref('')

function resultTextOf(result: 'CORRECT' | 'WRONG' | 'PENDING'): string {
  return (
    (result === 'CORRECT' ? '对了' : result === 'WRONG' ? '错了' : '记成「不会」') +
    (nextText() ? ` · 下次 ${nextText()}` : '')
  )
}

async function load(force = false): Promise<void> {
  busy.value = true
  err.value = ''
  q.value = null
  revealed.value = false
  picked.value = ''
  submitted.value = false
  view.value = 'question'
  resultText.value = ''
  others.value = []
  try {
    /* 外壳预取的题直接用（快速翻页不亮空壳）；force（AI 换句后的 reload）
       必须绕过缓存重新出，不然换完的例句还挂着旧题面 */
    const question =
      !force && props.question ? props.question : await makeQuestion(props.senseId, props.sentenceId)
    if (!question) {
      err.value = '这个意思还没有可练的句子'
      return
    }
    q.value = question
    shownAt.value = performance.now()
    emit('loaded', question)
    // ★ 外壳说这一页已经答过：把结果装回去（首页翻远再翻回来时组件会重挂）。
    //   这不只是「看着一样」—— 不恢复的话选项可再点，recordAnswer 会落第二次。
    const a = props.answered
    if (a) {
      if (a.outcome) question.outcome = a.outcome
      picked.value = a.picked
      revealed.value = true
      submitted.value = true
      resultText.value = resultTextOf(a.result)
    }
    const all = await db.sentences.where('senseId').equals(question.sense.id).toArray()
    others.value = all.filter((s) => s.id !== question.sentence.id && !s.flagged && s.zh)
  } finally {
    busy.value = false
  }
  // 每次装载都把状态报一次：外壳按页存它，翻回已作答的页时底栏才不会
  // 退回「我不会 / 显示选项」（那会让底栏出现一个点不动的按钮甚至空条）。
  emit('state', { revealed: revealed.value, submitted: submitted.value })
}

watch(() => [props.senseId, props.serial, props.sentenceId], () => void load(), { immediate: true })

/* 预取的题可能比组件晚到（首页窗口先挂上、预取还在路上）：
   到了且自己还没出成题，就换用预取的这道 —— 别让用户盯着「出题…」 */
watch(
  () => props.question,
  (nq) => {
    if (nq && !q.value && !err.value && !busy.value) void load()
  },
)

/** 点句子里的词：目标词在**作答前**不开查义（点了就等于泄题），
 *  但不能装死 —— 明说什么时候能点（用户反馈过「点了没反应」）。
 *  其它词随时可点 —— 读到不认识的字，应该能立刻查、立刻加进词库。 */
function onPick(w: string): void {
  const q0 = q.value
  if (!q0) return
  const forms = formsOfSentence(q0.sentence, q0.sense.word)
  const isTarget = forms.includes(w.toLowerCase())
  if (!submitted.value && isTarget) {
    toast('先作答 —— 答完再看这个词', 1900, true)
    return
  }
  // 句中 goal / goals / went 都是同一个词条；点高亮词形时按词条原形去查，
  // 否则 went 会被当成一个未入库的新词。
  emit('pick', isTarget ? q0.sense.word : w)
}

function reveal(): void {
  revealed.value = true
  emit('state', { revealed: true, submitted: false })
}

async function save(result: 'CORRECT' | 'WRONG' | 'PENDING'): Promise<void> {
  const question = q.value
  if (!question || submitted.value) return
  submitted.value = true
  const elapsed = shownAt.value ? Math.round(performance.now() - shownAt.value) : null
  const { outcome } = await recordAnswer(question, session, 0, result, elapsed)
  question.outcome = outcome
  resultText.value = resultTextOf(result)
  emit('answered', { result, picked: picked.value, outcome })
  emit('state', { revealed: revealed.value, submitted: true })
}

function choose(opt: string): void {
  if (submitted.value) return
  picked.value = opt
  void save(isRight(opt) ? 'CORRECT' : 'WRONG')
}

defineExpose({ reveal, save, reload: () => load(true) })
</script>

<template>
  <div class="qcard" :class="{ 'qcard-full': submitted }">
    <van-loading v-if="busy" color="#4f46e5">出题…</van-loading>
    <p v-else-if="err" class="err">{{ err }}</p>

    <template v-else-if="q">
      <header class="hd">
        <button class="w" type="button" @click="emit('word', q.sense.word)">
          {{ q.sense.word }}
        </button>
        <!-- 喇叭只读词，不读释义 —— 作答前听到意思等于泄题，发音不会 -->
        <button v-if="speechOn" class="say" :class="{ waiting: ttsWaiting }" type="button" aria-label="朗读单词" @click="speakEn(q.sense.word)">
          <van-icon name="volume-o" />
        </button>
        <span v-if="q.sense.pos" class="pos">{{ q.sense.pos }}</span>
        <span v-if="q.ipa" class="ipa">/{{ q.ipa }}/</span>
      </header>

      <div class="qbody" :class="{ 'ex-mode': view === 'examples' }">
        <div class="qflow" :class="{ 'qflow-fill': view === 'examples' }">
        <!-- 题目视图：句子 + 选项。切到「其它例句」时整块一起隐藏 -->
        <div v-show="view === 'question'" class="qview-question">
          <div class="snrow">
            <p class="sn">
              <MarkedText
                :text="q.sentence.en"
                :marks="q.sentence.marks"
                :form="q.sentence.form"
                :span-start="q.sentence.spanStart"
                :span-len="q.sentence.spanLen"
                :pickable="props.allowPick"
                @pick="onPick"
              />
            </p>
            <button v-if="speechOn" class="say sn-say" :class="{ waiting: ttsWaiting }" type="button" aria-label="朗读例句" @click="speakEn(q.sentence.en)">
              <van-icon name="volume-o" />
            </button>
          </div>

          <!-- 还没出选项（hideActions 时交给外壳的固定底栏） -->
          <div v-if="!revealed && !submitted && !props.hideActions" class="acts">
            <van-button block round @click="save('WRONG')">我不会</van-button>
            <van-button type="primary" block round @click="reveal">显示选项</van-button>
          </div>

          <!-- hideActions（首页屏一）：底栏按钮离句子一屏远，句子下面补一个
               轻量入口 —— 与背单词页同一个「点击空白处显示选项」的样子。
               封装在这里而不是首页手写，谁用 QuestionBox 谁就有。 -->
          <div
            v-else-if="!revealed && !submitted"
            class="blank"
            role="button"
            @click="reveal"
          >
            — 点击空白处显示选项 —
          </div>

          <div v-else-if="revealed || submitted" class="opts" :class="{ compact: submitted }">
            <button
              v-for="(opt, i) in q.options"
              :key="opt + i"
              class="opt"
              :class="{
                right: submitted && isRight(opt),
                wrong: submitted && opt === picked && !isRight(opt),
                dim: submitted && !isRight(opt) && opt !== picked,
              }"
              type="button"
              @click="choose(opt)"
            >
              <span class="k">{{ KEYS[i] }}</span>
              <span class="tx">{{ opt }}</span>
            </button>
            <button
              class="skipopt"
              :class="{ 'skipopt-giveup': submitted && !picked }"
              type="button"
              :disabled="submitted"
              @click="save('WRONG')"
            >
              我不会
            </button>
          </div>
        </div>

        <!-- 题面视图默认就显示句子中文与单词释义；
             切到「其它例句」后只留例句，题目本身的释义/翻译不再重复。 -->
        <div v-if="submitted" class="x" :class="{ 'x-fill': view === 'examples' }">
          <template v-if="view === 'question'">
            <p class="x-zh">{{ q.sentence.zh }}</p>
            <p class="x-g">
              <span class="x-pos">{{ q.sense.pos || '—' }}</span>
              {{ q.sense.gloss }}
            </p>
          </template>
          <div v-show="view === 'examples'" class="x-ex">
            <p class="x-h">
              <span>例句</span>
              <span class="x-count">{{ others.length }}</span>
              <span>条</span>
            </p>
            <div class="x-list">
              <div v-for="o in others" :key="o.id" class="x-o">
                <p class="x-en">{{ o.en }}</p>
                <p v-if="o.zh" class="x-zh2">{{ o.zh }}</p>
              </div>
              <p v-if="!others.length" class="x-empty">这个意思还没有其它例句</p>
            </div>
          </div>
        </div>
        </div>
      </div>

      <!-- 固定底栏：结论 + 切换 + 内容维护按钮。
           这一条不跟着题面/例句滚动；用户想翻页时从这里起手，
           不会被内部滚动抢走手势。 -->
      <div v-if="submitted" class="qfoot">
        <div
          v-if="!props.hideResult || others.length"
          class="resrow"
          :class="{ 'resrow-right': props.hideResult }"
        >
          <p v-if="!props.hideResult" class="res">{{ resultText }}</p>
          <button
            v-if="others.length"
            class="qview-b"
            type="button"
            :aria-expanded="view === 'examples'"
            @click="view = view === 'question' ? 'examples' : 'question'"
          >
            {{ view === 'question' ? '看其它例句' : '回题目' }}
          </button>
        </div>
        <div v-if="$slots.actions" class="qfoot-actions">
          <slot name="actions" />
        </div>
        <slot name="after" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.err {
  padding: 20px 0;
  text-align: center;
  font-size: 13px;
  color: var(--wb-ink-3);
}

.hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
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

.pos,
.ipa {
  font-size: 12px;
  color: var(--wb-ink-3);
}

.sn {
  font-size: 16.5px;
  line-height: 1.65;
  color: var(--wb-ink);
}

.snrow {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.snrow .sn {
  flex: 1;
  min-width: 0;
}

.say {
  border: 0;
  background: transparent;
  color: var(--wb-ink-3);
  font-size: 17px;
  padding: 2px 4px;
  cursor: pointer;
}

.say:active {
  color: var(--wb-primary);
}

/* 在线合成等待中：主题色 + 呼吸脉冲，告诉用户「在路上了，别狂点」 */
.say.waiting {
  color: var(--wb-primary);
  animation: say-wait 1s ease-in-out infinite;
}

@keyframes say-wait {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.sn-say {
  /* 跟例句第一行对齐，句子多长喇叭都钉在右上 */
  flex: 0 0 auto;
  margin-top: 1px;
}

/* 题面 / 例句的滚动体：卡片定高时只让这块滚，底栏保持不动 */
.qbody {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  scrollbar-width: none;
}

.qbody::-webkit-scrollbar {
  display: none;
}

/* 例句视图：句子 + 选项已经整块隐藏，这里不再整页滚；
   只有例句列表自己滚 */
.qbody.ex-mode {
  overflow: hidden;
}

/* 题目内容在卡片里垂直居中；内容比卡片高时自动从顶部开始，交给 qbody 滚 */
.qflow {
  margin: auto 0;
  min-height: 0;
}

.qflow-fill {
  flex: 1;
  margin: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.acts {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

/* 与 TrainPage .blank 同一个样子（虚线框 + 灰字）——
   两个页面长得像的入口，行为也必须一样（点下去都是 reveal） */
.blank {
  margin-top: 14px;
  background: var(--wb-card);
  border: 1.5px dashed var(--wb-line);
  border-radius: var(--wb-radius);
  padding: 14px;
  text-align: center;
  color: var(--wb-ink-3);
  font-size: 13px;
  cursor: pointer;
}

.blank:active {
  border-color: var(--wb-primary);
  color: var(--wb-primary);
}

.opts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
}

.opt {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 12px;
  border: 1px solid var(--wb-line);
  background: var(--wb-card);
  border-radius: 12px;
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.45;
  text-align: left;
  color: var(--wb-ink);
  cursor: pointer;
}

/* 作答后选项已经定性，收紧一点内边距，把高度留给下面的释义/翻译 */
.opts.compact .opt {
  padding: 9px 10px;
}

.opt .k {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--wb-bg);
  font-size: 11px;
  color: var(--wb-ink-3);
}

.opt.right {
  border-color: #12a05c;
  background: #f0fbf5;
}

.opt.right .k {
  background: #12a05c;
  color: #fff;
}

.opt.wrong {
  border-color: #d24b3e;
  background: #fdf1f0;
}

.opt.wrong .k {
  background: #d24b3e;
  color: #fff;
}

.opt.dim {
  opacity: 0.55;
}

/* 四个选项下面的长条「我不会」：是一个作答出口，按 WRONG 记。
   类名不能叫 .skip —— 训练页的进度格已有 .chip.skip。 */
.skipopt {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 42px;
  padding: 9px 12px;
  border: 1px dashed #d9dce4;
  border-radius: 12px;
  background: transparent;
  color: var(--wb-ink-2);
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
}

.skipopt:active {
  border-color: var(--wb-primary);
  background: #f7f8fb;
  color: var(--wb-primary);
}

/* 答过之后「我不会」仍留在选项下，保持布局不跳，但不再可点 */
.skipopt:disabled {
  cursor: default;
  opacity: 0.75;
}

/* 走「我不会」这条路：橙色标出这次诚实放弃，而不是当成某个错选项的红色 */
.skipopt-giveup {
  border-color: #e6a23c;
  background: #fff7e8;
  color: #8a5a12;
  font-weight: 600;
  opacity: 1;
}

/* 固定底栏：结论 + 切换 + 内容维护按钮。
   不参与上面的滚动，翻页手势从这里起手不会被内部滚动抢走。 */
.qfoot {
  flex: 0 0 auto;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--wb-line);
  background: var(--wb-card);
}

.resrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.resrow-right {
  justify-content: flex-end;
}

.res {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  color: var(--wb-primary);
}

/* 「看解析 / 回题目」：解析是次级内容，按钮也做小，不抢答题结论 */
.qview-b {
  flex: 0 0 auto;
  padding: 5px 10px;
  border: 1px solid var(--wb-line);
  border-radius: 999px;
  background: var(--wb-card);
  font-family: inherit;
  font-size: 12px;
  color: var(--wb-ink-2);
  cursor: pointer;
}

.qview-b:active {
  background: var(--wb-bg);
}

.x {
  margin-top: 10px;
  background: var(--wb-card);
  border-radius: 12px;
  padding: 10px 12px;
}

/* 题目视图里释义/翻译不再套灰卡：选项已经占掉不少高度，
   去掉这层 padding/底色后，默认就能同时看到释义与翻译。 */
.x:not(.x-fill) {
  background: transparent;
  border-radius: 0;
  padding: 0;
}

/* 例句视图：这张灰卡吃掉卡片剩余高度，释义钉在上面，
   例句列表在下面自己滚（卡片有最大高度，整页不跟着长） */
.x-fill {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.x-ex {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.x-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
}

.x-list::-webkit-scrollbar {
  display: none;
}

.x-empty {
  padding: 8px 0;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.x-zh {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--wb-ink-2);
}

/* 释义紧跟翻译：默认题面里选项占的地方多，这里不留浏览器默认段距 */
.x-g {
  margin: 6px 0 0;
  padding-top: 6px;
  border-top: 1px dashed var(--wb-line);
  font-size: 14.5px;
  font-weight: 600;
  color: var(--wb-ink);
}

.x-pos {
  font-size: 11px;
  font-weight: 400;
  color: var(--wb-ink-3);
  margin-right: 6px;
}

.x-h {
  margin: 0 0 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--wb-ink-3);
}

.x-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wb-bg);
  color: var(--wb-primary);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.x-o {
  padding: 6px 0;
  border-top: 1px dashed var(--wb-line);
}

.x-en {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--wb-ink);
}

.x-zh2 {
  font-size: 12px;
  line-height: 1.6;
  color: var(--wb-ink-3);
}
</style>
