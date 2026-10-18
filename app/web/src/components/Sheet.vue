<script setup lang="ts">
/** 底部弹出层 —— 导入对比 / 复制模板 / 合并拆分都用它。
 *  底下是 Vant 的 Popup：手势下滑关闭、安全区、滚动锁定都归它管，
 *  这里只补头部与底部按钮条。
 */
defineProps<{
  open: boolean
  title: string
  /** 右上角小标记，如「逐条决策」 */
  badge?: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <van-popup
    :show="open"
    position="bottom"
    round
    :style="{ maxHeight: '88dvh', display: 'flex', flexDirection: 'column' }"
    @update:show="(v: boolean) => !v && emit('close')"
  >
    <div class="sh-h">
      <h2>{{ title }}</h2>
      <span v-if="badge" class="tag warn">{{ badge }}</span>
      <span class="wb-sp" />
      <van-button size="mini" plain @click="emit('close')">关闭</van-button>
    </div>
    <div class="sh-b">
      <slot />
    </div>
    <div v-if="$slots.footer" class="sh-f">
      <slot name="footer" />
    </div>
  </van-popup>
</template>

<style scoped>
.sh-h {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--wb-line);
  flex: 0 0 auto;
}

.sh-h h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.sh-b {
  overflow-y: auto;
  /* 全站仅有的第二个滚动上下文，同样要显式禁。
     留成默认的 auto 有两个口子：一，它自己会橡皮筋；
     二，越界会**传给祖先**——弹层里滑到底再往上拖，整页跟着动。
     这两样在真机上都是「看起来像 bug 但说不清哪来的」。
     判据见 docs/decisions/D34-固定栏与橡皮筋.md。 */
  overscroll-behavior: none;
  padding: 14px 16px;
  flex: 1 1 auto;
  -webkit-overflow-scrolling: touch;
}

.sh-f {
  padding: 10px 16px calc(12px + var(--wb-safe-bottom));
  border-top: 1px solid var(--wb-line);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  flex: 0 0 auto;
}
</style>