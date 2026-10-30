<script setup lang="ts">
/** 复制给 AI —— 把现有内容 + 要求 + 输出格式拼成一段纯文本，
 *  粘到豆包 / DeepSeek 之类，回来的 JSON 走 ImportSheet。
 */
import Sheet from './Sheet.vue'
import { copyToClipboard } from '../fileio'
import { toast } from '../toast'

const props = defineProps<{ open: boolean; title: string; text: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/**
 * 复制成功就**收起弹层**，复制失败留着。
 *
 *  为什么成功要收：这段模板十几行，复制完的下一步是切到豆包/DeepSeek 去粘贴，
 *  一块 88dvh 的弹层正好挡着输入框，还要用户先想到去关它。
 *  为什么失败留着：提示语是「请手动选中复制」—— 那条路要看得见文本才做得到，
 *  一收起来这个提示就成了空话。
 */
async function copy(): Promise<void> {
  if (await copyToClipboard(props.text)) {
    emit('close')
    toast('已复制，去问 AI')
  } else {
    toast('复制失败，请手动选中复制')
  }
}
</script>

<template>
  <Sheet :open="open" :title="title" @close="emit('close')">
    <p class="hint">粘给 AI，回它的 JSON 粘到「导入 JSON」。</p>
    <van-field :model-value="text" type="textarea" rows="12" autosize readonly label="" />
    <!-- ★ 按钮放在 Sheet 的 footer 槽里，不放在内容里。
         模板十几行，内容比一屏长；按钮跟着内容排在最后，
         就必须「滚到底才看得见它」—— 而按钮是这一屏唯一的动作，
         用户得先滑一屏才能拿到它（真机上确实如此）。
         footer 槽是 flex:0 0 auto 的固定条，不参与 .sh-b 的滚动，
         所以无论模板多长它都在拇指够得着的地方。 -->
    <template #footer>
      <van-button class="cp" type="primary" block @click="copy">复制到剪贴板</van-button>
    </template>
  </Sheet>
</template>

<style scoped>
.hint {
  background: #eef2ff;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: #3730a3;
  margin: 0 0 12px;
}

:deep(.van-field) {
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 10px 11px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.6;
}

.cp {
  width: 100%;
  /* footer 槽已经给了 10px 16px 的内边距，这里别再叠一层 */
  margin: 0;
}
</style>