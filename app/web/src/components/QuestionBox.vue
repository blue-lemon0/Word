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
import { makeQuestion, newSessionId, recordAnswer, type Question } from '../quiz'
import type { Sentence } from '../types'

const props = defineProps<{
  /** true = 不自带「我不会 / 显示选项」，由外壳固定底栏渲染（首页屏一用） */
  hideActions?: boolean
  /** true = 作答后句子里的词可点开（查义） */
  allowPick?: boolean
  senseId: string
  /** 钉住哪一句（扫读点的那句）。不给就随机 */
  sentenceId?: number
  /** 序号，让组件知道「换题了」（同一 sense 连练两句时也要重开） */
  serial?: number
}>()

const emit = defineEmits<{
  (e: 'word', w: string): void
  (e: 'answered', result: 'CORRECT' | 'WRONG' | 'PENDING'): void
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
const busy = ref(false)
const err = ref('')
const others = ref<Sentence[]>([])
const session = newSessionId()
const shownAt = ref(0)

const isRight = (opt: string): boolean => !!q.value && opt === q.value.sense.gloss

function nextText(): string {
  const d = q.value?.outcome?.intervalDays
  if (d == null) return ''
  return d < 1 ? '今天内' : d < 2 ? '明天' : `${Math.round(d)} 天后`
}

const resultText = ref('')

async function load(): Promise<void> {
  busy.value = true
  err.value = ''
  q.value = null
  revealed.value = false
  picked.value = ''
  submitted.value = false
  resultText.value = ''
  others.value = []
  try {
    const question = await makeQuestion(props.senseId, props.sentenceId)
    if (!question) {
      err.value = '这个意思还没有可练的句子'
      return
    }
    q.value = question
    shownAt.value = performance.now()
    emit('loaded', question)
    const all = await db.sentences.where('senseId').equals(question.sense.id).toArray()
    others.value = all
      .filter((s) => s.id !== question.sentence.id && !s.flagged && s.zh)
      .slice(0, 2)
  } finally {
    busy.value = false
  }
}

watch(() => [props.senseId, props.serial, props.sentenceId], load, { immediate: true })

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
  resultText.value =
    (result === 'CORRECT' ? '对了' : result === 'WRONG' ? '错了' : '记成「不会」') +
    (nextText() ? ` · 下次 ${nextText()}` : '')
  emit('answered', result)
  emit('state', { revealed: true, submitted: true })
}

function choose(opt: string): void {
  if (submitted.value) return
  picked.value = opt
  void save(isRight(opt) ? 'CORRECT' : 'WRONG')
}

defineExpose({ reveal, save })
</script>

<template>
  <div class="qb">
    <van-loading v-if="busy" color="#4f46e5">出题…</van-loading>
    <p v-else-if="err" class="err">{{ err }}</p>

    <template v-else-if="q">
      <header class="hd">
        <button class="w" type="button" @click="emit('word', q.sense.word)">
          {{ q.sense.word }}
        </button>
        <span v-if="q.sense.pos" class="pos">{{ q.sense.pos }}</span>
        <span v-if="q.ipa" class="ipa">/{{ q.ipa }}/</span>
      </header>

      <p class="sn">
        <MarkedText
          :text="q.sentence.en"
          :form="q.sentence.form"
          :span-start="q.sentence.spanStart"
          :span-len="q.sentence.spanLen"
          :pickable="props.allowPick && submitted"
          @pick="emit('pick', $event)"
        />
      </p>

      <!-- 还没出选项（hideActions 时交给外壳的固定底栏） -->
      <div v-if="!revealed && !submitted && !props.hideActions" class="acts">
        <van-button block round @click="save('PENDING')">我不会</van-button>
        <van-button type="primary" block round @click="reveal">显示选项</van-button>
      </div>

      <!-- 选项 -->
      <div v-else-if="revealed || submitted" class="opts">
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
      </div>

      <!-- 答完：结论 + 这一句的解析 -->
      <template v-if="submitted">
        <p class="res">{{ resultText }}</p>
        <div class="x">
          <p class="x-zh">{{ q.sentence.zh }}</p>
          <p class="x-g">
            <span class="x-pos">{{ q.sense.pos || '—' }}</span>
            {{ q.sense.gloss }}
          </p>
          <template v-if="others.length">
            <p class="x-h">同一个意思的其它例句</p>
            <div v-for="o in others" :key="o.id" class="x-o">
              <p class="x-en">{{ o.en }}</p>
              <p v-if="o.zh" class="x-zh2">{{ o.zh }}</p>
            </div>
          </template>
        </div>
        <slot name="after" />
      </template>
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

.acts {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

.opts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 14px;
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

.res {
  margin-top: 14px;
  font-size: 14.5px;
  font-weight: 650;
  color: var(--wb-primary);
}

.x {
  margin-top: 10px;
  background: var(--wb-bg);
  border-radius: 12px;
  padding: 10px 12px;
}

.x-zh {
  font-size: 13px;
  line-height: 1.7;
  color: var(--wb-ink-2);
}

.x-g {
  margin-top: 8px;
  padding-top: 8px;
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
  margin: 10px 0 4px;
  font-size: 11.5px;
  color: var(--wb-ink-3);
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
