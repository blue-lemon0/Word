<script setup lang="ts">
/** 例句渲染：把目标词那一段包进 <mark>。
 *
 *  span 来自 content-kit 审计脚本的机械定位（sentence_audit.py --fix-spans
 *  可重算），AI 导入的句子则在 import.ts 里现算。两处都保证
 *  text.slice(spanStart, spanStart+spanLen) === form；这里仍做一次校验，
 *  对不上就退回「按 form 找一遍」，找不到就整句不高亮 —— 宁可不高亮，
 *  也不能把高亮打到别的词上（训练时那等于告诉用户错误的答案位置）。
 */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    text: string
    form?: string
    spanStart?: number
    spanLen?: number
    /** 可点：点了回调整句里的某个词（首页顺藤摸瓜进单词页） */
    pickable?: boolean
  }>(),
  { form: '', spanStart: -1, spanLen: 0, pickable: false },
)

const emit = defineEmits<{ (e: 'pick', word: string): void }>()

const parts = computed(() => {
  let start = props.spanStart
  let len = props.spanLen
  const ok =
    start >= 0 && len > 0 && props.text.slice(start, start + len).toLowerCase() === props.form.toLowerCase()
  if (!ok && props.form) {
    const i = props.text.toLowerCase().indexOf(props.form.toLowerCase())
    if (i >= 0) {
      start = i
      len = props.form.length
    } else {
      start = -1
      len = 0
    }
  }
  if (start < 0) return null
  return {
    before: props.text.slice(0, start),
    hit: props.text.slice(start, start + len),
    after: props.text.slice(start + len),
  }
})

const tokens = computed(() =>
  props.pickable
    ? props.text.split(/(\s+|[,.;:!?()"'—–-])/).filter((t) => t !== '')
    : null,
)

/** 可点模式下某个词是不是目标词 —— 高亮和「顺藤摸瓜」要各管各的：
 *  高亮告诉眼睛「看这里」，点击是去那个词的词条。所以两者都要认 form。 */
function isHit(tok: string): boolean {
  if (!props.form) return false
  return tok.toLowerCase().replace(/[^a-z0-9'-]/g, '') === props.form.toLowerCase()
}

function onPickToken(tok: string): void {
  const w = tok.replace(/[^A-Za-z'-]/g, '').toLowerCase()
  if (w) emit('pick', w)
}
</script>

<template>
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
  <template v-else-if="parts">
    {{ parts.before }}<mark>{{ parts.hit }}</mark>{{ parts.after }}
  </template>
  <template v-else>{{ text }}</template>
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

/* 可点 + 高亮：hover 的反馈不能盖住高亮本身，否则鼠标一放上去
   就看不出该盯哪个词了 */
.pickable .hit {
  background: #fff0b3;
  color: inherit;
  font-weight: 600;
  padding: 1px 2px;
}
</style>