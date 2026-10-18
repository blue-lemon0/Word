<script setup lang="ts">
/** 顶栏返回箭头 —— **唯一的返回按钮**（四个页面都用它）。
 *
 *  ★ 为什么要单独做成组件：原来每页都写一句
 *    `<van-icon name="arrow-left" size="18" @click="goBack(...)" />`，
 *    而 van-icon 的可点区域就是那个 18×18 的字形本身。
 *    真机上手指落点在字形边上 3mm，就什么都不会发生 ——
 *    用户的原话是「左上角返回键经常没反应」。
 *    按钮本身没问题，是**热区太小**：44×44 才是能稳定点中的尺寸。
 *
 *  ★ 视觉上仍然是 18px 的箭头：热区用 padding 撑开，图标居中；
 *    左边留一点负外边距，让它和标题的对齐跟原来一样。
 */
const emit = defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <button class="backbtn" type="button" aria-label="返回" @click.stop="emit('click')">
    <van-icon name="arrow-left" size="18" />
  </button>
</template>

<style scoped>
.backbtn {
  /* 44×44 = 能稳定点中的最小尺寸；视觉仍是一个小箭头 */
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -10px;
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: 12px;
  color: var(--wb-ink);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.backbtn:active {
  background: rgba(0, 0, 0, 0.05);
}
</style>
