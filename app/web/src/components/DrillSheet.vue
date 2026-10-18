<script setup lang="ts">
/** 练一句 —— **浮层，不是一个房间**。
 *
 *  ★ 判据：练一句话要多久回到原来的地方？进页面的话，得先退出来（一次点击 +
 *    一次转场 + 一次状态恢复），而人本来只是想「这一句没懂，练一下」。
 *    做成浮层之后：关掉就在原地。
 *
 *  ★ 题目本体在 QuestionBox 里（和首页的练习副页共用一份）：
 *    判分链路完全一致，浮层不是「另一个迷你练习」。
 */
import { ref, watch } from 'vue'
import QuestionBox from './QuestionBox.vue'

const props = defineProps<{
  open: boolean
  senseId: string
  sentenceId?: number
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'word', w: string): void }>()

/** 换题计数：点「再练一次」时 +1，让 QuestionBox 重新出题 */
const serial = ref(0)

watch(
  () => props.open,
  (open) => {
    if (open) serial.value++
  },
  { immediate: true },
)
</script>

<template>
  <van-popup
    :show="props.open"
    position="bottom"
    round
    close-on-popstate
    class="drill-pop"
    @close="emit('close')"
  >
    <div class="dr">
      <QuestionBox
        :sense-id="props.senseId"
        :sentence-id="props.sentenceId"
        :serial="serial"
        @word="emit('word', $event)"
      >
        <template #after>
          <div class="acts">
            <van-button block round @click="emit('close')">继续扫</van-button>
            <van-button type="primary" block round @click="serial++">再练一次</van-button>
          </div>
        </template>
      </QuestionBox>
    </div>
  </van-popup>
</template>

<style scoped>
/* ★ 高度固定，不跟着内容长 —— 内容多的时候高度一跳，人正在点的按钮会跑掉。
   定高 + 内部滚动：第一次打开和答完题之后，浮层是同一个盒子。 */
.drill-pop {
  height: 76vh;
}

.dr {
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 16px 16px calc(14px + env(safe-area-inset-bottom, 0px));
}

.acts {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
</style>
