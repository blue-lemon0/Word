<script setup lang="ts">
/** 复习量预测图 —— 未来 90 天，每天一根柱子。
 *
 *  ★ 为什么自绘不引图表库：90 根等宽柱子是 flex 一排 div 的事，
 *    引 ECharts 那种库（几百 KB）就为这一张图不值当，离线包里每 KB 都是钱。
 *
 *  ★ 交互只有一下：点某根柱子，上方浮出「X月X日 · 约 N 个」。
 *    90 根柱子在手机上一根不到 4px 宽，长按精确点选不现实 ——
 *    所以选中态不需要精细，点到哪根是哪根，松手即留。
 *
 *  ★ 组件只收数据、只画图：推演口径在 forecast.ts，这里一个公式都不该有。
 */
import { computed, ref } from 'vue'
import type { ForecastResult } from '../forecast'

const props = defineProps<{ data: ForecastResult }>()

const picked = ref(-1)

const max = computed(() => Math.max(1, ...props.data.counts))

/** 柱子高度百分比；空窗日（0 个）留 2% 浅灰占位，有量的日子上主题色 ——
 *  全灰的图看起来像「只有今天有事」，颜色必须跟着「有没有量」走 */
const bars = computed(() =>
  props.data.counts.map((n, i) => ({
    n,
    i,
    h: n === 0 ? 2 : Math.max(4, Math.round((n / max.value) * 100)),
    empty: n === 0,
  })),
)

const pickedLabel = computed(() => {
  const i = picked.value
  if (i < 0) return ''
  const d = new Date(Date.now() + i * 86400000)
  return `${d.getMonth() + 1}月${d.getDate()}日 · 约 ${props.data.counts[i]} 个`
})

function pick(i: number): void {
  picked.value = picked.value === i ? -1 : i
}
</script>

<template>
  <div class="fc">
    <div class="fc-label" :class="{ dim: picked < 0 }">{{ pickedLabel || '点柱子看具体某天' }}</div>
    <div class="fc-bars">
      <button
        v-for="b in bars"
        :key="b.i"
        class="fc-bar"
        :class="{ today: b.i === 0, on: b.i === picked, empty: b.empty }"
        :style="{ height: b.h + '%' }"
        type="button"
        :aria-label="`第${b.i + 1}天 ${b.n}个`"
        @click="pick(b.i)"
      />
    </div>
    <div class="fc-axis"><span>今天</span><span>30天</span><span>60天</span><span>90天</span></div>
  </div>
</template>

<style scoped>
.fc {
  user-select: none;
}

.fc-label {
  height: 18px;
  font-size: 11.5px;
  color: var(--wb-ink-2);
  text-align: center;
  margin-bottom: 4px;
}

.fc-label.dim {
  color: var(--wb-ink-3);
}

.fc-bars {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 44px;
}

.fc-bar {
  flex: 1 1 0;
  min-width: 0;
  border: 0;
  padding: 0;
  border-radius: 1px 1px 0 0;
  background: var(--primary);
  opacity: 0.45;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* 今天加重：它是「起点」，不是普通的一天 */
.fc-bar.today {
  opacity: 1;
}

/* 空窗日回到浅灰，跟「有量」拉开 */
.fc-bar.empty {
  background: var(--wb-line);
  opacity: 1;
}

.fc-bar.on {
  background: var(--wb-ink-2);
  opacity: 1;
}

.fc-axis {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--wb-ink-3);
  margin-top: 3px;
}
</style>
