<script setup lang="ts">
/** 例句渲染：把目标词在句中的**所有**出现位置包进 <mark>。
 *
 *  marks 是 AI highlights 数组落成的区间（可能多个词形/多次出现）；旧数据
 *  没有 marks 时回退到 spanStart/spanLen/form。两处都校验「切出来的文本
 *  真的是 form」，对不上就按 form 重找，找不到就整句不高亮 —— 宁可不高亮，
 *  也不能把高亮打到别的词上（训练时那等于告诉用户错误的答案位置）。
 */
import { computed } from 'vue'
import { marksOfSentence } from '../marks'
import type { SentenceMark } from '../types'

const props = withDefaults(
  defineProps<{
    text: string
    marks?: SentenceMark[]
    form?: string
    spanStart?: number
    spanLen?: number
    /** 可点：点了回调整句里的某个词（首页顺藤摸瓜进单词页） */
    pickable?: boolean
  }>(),
  { form: '', spanStart: -1, spanLen: 0, pickable: false },
)

const emit = defineEmits<{ (e: 'pick', word: string): void }>()

const hits = computed(() =>
  marksOfSentence({
    en: props.text,
    marks: props.marks,
    form: props.form,
    spanStart: props.spanStart,
    spanLen: props.spanLen,
  }),
)

const segments = computed(() => {
  const list = hits.value
  if (!list.length) return null
  const out: { text: string; hit: boolean }[] = []
  let at = 0
  for (const m of list) {
    if (m.start > at) out.push({ text: props.text.slice(at, m.start), hit: false })
    out.push({ text: props.text.slice(m.start, m.start + m.len), hit: true })
    at = m.start + m.len
  }
  if (at < props.text.length) out.push({ text: props.text.slice(at), hit: false })
  return out
})

const tokens = computed(() =>
  props.pickable
    ? props.text.split(/(\s+|[,.;:!?()"'—–-])/).filter((t) => t !== '')
    : null,
)

const hitForms = computed(() => new Set(hits.value.map((m) => m.form.toLowerCase())))

/** 可点模式下某个词是不是目标词 —— 高亮和「顺藤摸瓜」要各管各的：
 *  高亮告诉眼睛「看这里」，点击是去那个词的词条。所以两者都要认高亮词形。 */
function isHit(tok: string): boolean {
  const w = tok.toLowerCase().replace(/[^a-z0-9'-]/g, '')
  return !!w && hitForms.value.has(w)
}

function onPickToken(tok: string): void {
  const w = tok.replace(/[^A-Za-z'-]/g, '').toLowerCase()
  if (w) emit('pick', w)
}
</script>

<template>
  <!-- ★ 必须有**唯一**根元素。原来是三个分支（span / 文本+mark / 文本），
       属于「多根节点」：Vue 无法把父组件传下来的 class 挂上去，
       只会警告 Extraneous non-props attributes，
       于是调用方写的 class="tx" 静默失效 —— 排版就按「没有这个 class」渲染。
       扫读页的行号/词性/句子对不齐，根子在这里：
       句子被拆成「文本节点 + <mark>」两个匿名 flex item 各自排版。
       包一个根 span 之后 class / style / 事件都能正常落上去。 -->
  <span class="wb-marked">
    <!-- 可点模式：整句逐词切分，每个词能点（顺藤摸瓜进词条）；
         目标词那一格照样要高亮 —— 不然首页的例句看着和普通的句子没区别，
         用户不知道该盯哪个词。 -->
    <span v-if="pickable && tokens" class="pickable">
      <span
        v-for="(tok, i) in tokens"
        :key="i"
      :class="{ link: /[A-Za-z]/.test(tok) && tok.trim() !== '', hit: isHit(tok) }"
      @click="onPickToken(tok)"
      >{{ tok }}</span
    >
    </span>
    <template v-else-if="segments">
      <template v-for="(seg, i) in segments" :key="i">
        <mark v-if="seg.hit">{{ seg.text }}</mark>
        <template v-else>{{ seg.text }}</template>
      </template>
    </template>
    <template v-else>{{ text }}</template>
  </span>
</template>

<style scoped>
.pickable .link {
  cursor: pointer;
  border-radius: 3px;
}

.pickable .link:hover {
  background: var(--primary-soft);
  color: var(--primary);
}

/* 手机上没有 hover：按下时给一次反馈，别让人怀疑「点了个寂寞」 */
.pickable .link:active {
  background: var(--primary-soft);
  color: var(--primary);
}

/* 可点 + 高亮：hover 的反馈不能盖住高亮本身，否则鼠标一放上去
   就看不出该盯哪个词了 */
.pickable .hit {
  background: #fff0b3;
  color: inherit;
  font-weight: 600;
  padding: 1px 2px;
}
</style>