<script setup lang="ts">
/**
 * 新增词 —— 输入英文（可带音标），建词条 + 它的第一个意思。
 *
 *  为什么单独做一个弹层而不是把输入框塞进词库页：
 *  加词是**低频但关键**的动作（大部分内容来自内容包），
 *  不值得在词库页常驻一条输入框；可它又必须**一眼可见** ——
 *  原来的界面上根本没有建词路径，用户只能去导入整个内容包。
 *  折中就是：入口常驻（词库页顶栏一个「+」），点开才展开表单。
 *
 *  加完直接跳到那个意思的编辑页：释义还没有，趁上下文还热立刻填。
 */
import { ref } from 'vue'
import Sheet from './Sheet.vue'
import { addWord } from '../edit'
import { toast } from '../toast'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'added', senseId: string): void }>()

const word = ref('')
const ipa = ref('')

function reset(): void {
  word.value = ''
  ipa.value = ''
}

async function submit(): Promise<void> {
  try {
    const r = await addWord(word.value, ipa.value)
    toast(`已加「${r.word}」，去填第一个意思`)
    emit('added', r.senseId)
    emit('close')
    reset()
  } catch (e) {
    toast((e as Error).message)
  }
}
</script>

<template>
  <Sheet :open="props.open" title="新增一个词" @close="emit('close')">
    <p class="hint">
      填英文单词就行，音标可以先空着。保存后会直接进那个意思的编辑页 ——
      没有释义的意思在练习里等于不存在。
    </p>
    <van-field v-model="word" placeholder="例如 nuance" label="" autocapitalize="off" />
    <van-field
      v-model="ipa"
      placeholder="音标，可留空：/ˈnuːɑːns/"
      label=""
      class="ipa"
    />
    <template #footer>
      <van-button block round @click="emit('close')">取消</van-button>
      <van-button type="primary" block round @click="submit">加进词库</van-button>
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
  line-height: 1.6;
}

.ipa {
  margin-top: 8px;
}

:deep(.van-cell) {
  background: var(--wb-bg);
  border-radius: 10px;
  padding: 10px 11px;
  font-size: 15px;
}
</style>