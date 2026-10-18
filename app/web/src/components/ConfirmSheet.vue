<script setup lang="ts">
/** 确认弹层 —— 取代浏览器原生的 `confirm()` / `prompt()`。
 *
 *  为什么不用原生的：WebView 里 `confirm()` 弹出来的是 Chromium 的系统对话框，
 *  上面压着一行 "The page at "https://appassets.androidplatform.net" s…"，
 *  按钮是 CANCEL / OK，正文还是一段挤在一起的纯文本。真机截图里它和
 *  整个 app 没有一点关系，像是弹错了东西 —— 而这恰恰是「删掉不可逆内容」
 *  这种最需要用户停下来看一眼的地方。
 *
 *  用底部弹层（和其余 Sheet 同一套外观）+ 中文按钮 + 分行正文，
 *  破坏性操作用红色按钮。`input` 模式顺带把 `prompt()` 也收进来。
 */
import { ref, watch } from 'vue'
import Sheet from './Sheet.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** 正文。里面的 \n 会保留成换行。 */
    text?: string
    /** 确认按钮上的字 */
    okText?: string
    /** 破坏性操作：确认按钮用红色 */
    danger?: boolean
    /** 需要填一句（比如拆分义项时填新释义），确认时把内容回传 */
    input?: boolean
    placeholder?: string
  }>(),
  { text: '', okText: '确定', danger: false, input: false, placeholder: '' },
)

const emit = defineEmits<{ (e: 'close'): void; (e: 'confirm', value: string): void }>()

const value = ref('')

/* 每次打开都清空：不清的话「拆分」第二次打开会带着上一次写的释义，
   而用户以为那是新填的。 */
watch(
  () => props.open,
  (open) => {
    if (open) value.value = ''
  },
)

function done(): void {
  if (props.input && !value.value.trim()) return
  emit('confirm', value.value.trim())
}
</script>

<template>
  <Sheet :open="open" :title="title" @close="emit('close')">
    <p v-if="text" class="ctext">{{ text }}</p>
    <van-field
      v-if="input"
      v-model="value"
      :placeholder="placeholder"
      rows="2"
      autosize
      label=""
    />
    <template #footer>
      <div class="cfoot">
        <van-button size="small" plain @click="emit('close')">取消</van-button>
        <van-button
          size="small"
          :type="danger ? 'danger' : 'primary'"
          :disabled="input && !value.trim()"
          @click="done"
        >
          {{ okText }}
        </van-button>
      </div>
    </template>
  </Sheet>
</template>

<style scoped>
/* pre-wrap：正文里的 \n 要真的换行。不写的话整段挤成一行，
   恰恰是原来那个原生对话框最难读的地方。 */
.ctext {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--wb-ink-2);
  white-space: pre-wrap;
}

.cfoot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>