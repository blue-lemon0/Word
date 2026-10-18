<script setup lang="ts">
/**
 * 左右滑动切换的面板组 —— 一条横排的分段标题 + 一屏一个面板。
 *
 *  为什么手写而不用 van-tabs：本项目的规矩是「先在真机上点一遍再加组件」
 * （见 tests/WEBVIEW-CRASHES.md —— van-dropdown-menu 就是这么崩的）。
 * 这个容器要控制的恰恰是那些组件管不住的东西：
 *   - **首帧就要有内容**：坑 42 说过「第一帧不管渲染什么都是跳变」。
 *     van-tabs 的 lazy render 会先出一个空面板，这里三个面板全部同步渲染。
 *   - **动画只在松手之后开**：拖动过程中开着 transition 会让内容「追着手指跑」，
 *     提交顺序错了还会出现错位中间帧（坑 27）。
 *
 *  三条让它在手机上真正好用的细节，少一条就翻车：
 *   1. **`touch-action: pan-y`** —— 没有它，浏览器会自己抢走横向手势，
 *      表现为「怎么滑都不动」或者「一滑页面就跟着横着跑」。这是最常见的一条。
 *   2. **轴向锁定**：只有横向位移明显大于纵向时才认定为滑动。
 *      面板里装着会上下滚的清单（.cap-list），不分轴的话上下滚动全被吃掉。
 *   3. **不 preventDefault**：一旦阻止默认行为，页面滚动就没了。
 */
import { computed, onMounted, ref } from 'vue'

export interface Panel {
  key: string
  label: string
  count?: number | null
}

const props = defineProps<{ panels: Panel[]; initial?: number }>()
const emit = defineEmits<{ (e: 'change', key: string): void }>()

const idx = ref(props.initial ?? 0)
const dx = ref(0) // 拖动中的横向位移（px）
const animating = ref(false)
const vp = ref<HTMLElement | null>(null)
const width = ref(0)

const n = computed(() => Math.max(1, props.panels.length))
/** 每个面板占轨道的百分比（百分比相对轨道自身宽度，所以不需要测量宽度） */
const step = computed(() => 100 / n.value)

const base = computed(() => -idx.value * step.value)
const transform = computed(() =>
  dx.value ? `translateX(calc(${base.value}% + ${dx.value}px))` : `translateX(${base.value}%)`,
)

const start = ref(0)
const startY = ref(0)
const locked = ref<'none' | 'x' | 'y'>('none')
const widthOf = (): number => vp.value?.getBoundingClientRect().width ?? window.innerWidth

function onDown(e: TouchEvent): void {
  if (n.value < 2) return
  start.value = e.touches[0].clientX
  startY.value = e.touches[0].clientY
  locked.value = 'none'
  width.value = widthOf()
  animating.value = false
}

function onMove(e: TouchEvent): void {
  if (n.value < 2 || !start.value) return
  const dxp = e.touches[0].clientX - start.value
  const dyp = e.touches[0].clientY - startY.value

  // 轴向锁定：横向明显占优才接管，否则交还给页面/面板里的纵向滚动
  if (locked.value === 'none') {
    if (Math.abs(dxp) < 8 && Math.abs(dyp) < 8) return
    locked.value = Math.abs(dxp) > Math.abs(dyp) ? 'x' : 'y'
  }
  if (locked.value !== 'x') return

  // 头尾不给出界位移：只有第一屏不能往左拖出更多（那后面没有面板了），
  // 只有最后一屏不能往右。
  //   负 dx = 内容左移 = 露出**右**边那一屏（去下一个）
  //   正 dx = 内容右移 = 露出**左**边那一屏（去上一个）
  // 所以允许区间是 [-(还剩几屏)*宽, (已过几屏)*宽]。
  // ⚠ 这里曾经写反过一次：idx=0 时把 min 设成 0，于是「从第一屏往左滑」
  //   ——也就是最常用的那一下—— 被自己夹成 0，看起来是「怎么滑都不动」。
  //   事件确实到了（touchstart 1 / touchmove 12 / touchend 1），
  //   所以别去查事件绑定，先算一遍这个区间。
  const roomNext = width.value * (n.value - 1 - idx.value)
  const roomPrev = width.value * idx.value
  dx.value = Math.min(roomPrev, Math.max(-roomNext, dxp))
}

function onUp(): void {
  if (locked.value !== 'x') {
    dx.value = 0
    start.value = 0
    return
  }
  // 过了三成宽（或 48px，取小的）才切 —— 一点点位移就跳页会让人很容易误操作
  const w = width.value || widthOf()
  const th = Math.min(w * 0.3, 160)
  if (dx.value <= -th && idx.value < n.value - 1) go(idx.value + 1)
  else if (dx.value >= th && idx.value > 0) go(idx.value - 1)
  dx.value = 0
  start.value = 0
}

function go(i: number): void {
  if (i === idx.value || i < 0 || i >= n.value) return
  idx.value = i
  animating.value = true
  emit('change', props.panels[i].key)
}

function onTransitionEnd(): void {
  animating.value = false
}

onMounted(() => {
  width.value = widthOf()
})
</script>

<template>
  <div class="sp">
    <div class="bar" role="tablist">
      <button
        v-for="(p, i) in panels"
        :key="p.key"
        class="t"
        :class="{ on: i === idx }"
        role="tab"
        :aria-selected="i === idx"
        type="button"
        @click="go(i)"
      >
        {{ p.label }}<span v-if="p.count != null" class="c">{{ p.count }}</span>
      </button>
    </div>

    <!-- touch-action: pan-y 是这条能用的前提，见文件头 -->
    <div
      ref="vp"
      class="vp"
      @touchstart.passive="onDown"
      @touchmove.passive="onMove"
      @touchend="onUp"
      @touchcancel="onUp"
    >
      <div
        class="track"
        :style="{
          '--n': n,
          width: `calc(${n} * 100%)`,
          transform,
          transition: animating ? 'transform .22s ease' : 'none',
        }"
        @transitionend="onTransitionEnd"
      >
        <div v-for="p in panels" :key="p.key" class="pane" role="tabpanel">
          <slot :name="p.key" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp {
  background: var(--wb-card);
}

.bar {
  display: flex;
  gap: 6px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--wb-line);
}

.t {
  flex: 1 1 0;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--wb-ink-2);
  font-size: 13.5px;
  font-family: inherit;
  padding: 7px 4px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}

.t.on {
  background: rgba(79, 70, 229, 0.09);
  color: var(--wb-primary);
  font-weight: 600;
}

.c {
  margin-left: 5px;
  font-size: 11px;
  color: var(--wb-ink-3);
}

.t.on .c {
  color: var(--wb-primary);
}

/* ★ pan-y：浏览器只把纵向手势交给我们，横向留给页面自己判。
   少了这一句，横向滑动会变成「页面横着跑」或者「完全不动」。 */
.vp {
  overflow: hidden;
  touch-action: pan-y;
}

.track {
  display: flex;
  height: 100%;
  will-change: transform;
}

/* ★ 面板宽度是 100%/N，不是 100%。
 *
 *   `flex: 0 0 100%` 里的 100% 解析的是**flex 容器**的宽度，
 *   而容器是轨道（宽度 = N × 视口）—— 于是每个面板都变成 N 倍视口宽，
 *   面板 2、3 被推到 x = N×视口 之外；而切换时按 100/N% 平移
 *   （= 一个视口宽），于是**每一页看到的其实都是第一页的中间一段**。
 *   真机实测：面板宽 1008（视口只有 336），
 *   切到「回收站」却满屏是快照那一栏的「回滚」行。
 *
 *   症状极其误导：功能都在、数据都在，只是错位 ——
 *   所以要去量 rect，不要盯着「点了没反应」想。
 */
.pane {
  flex: 0 0 auto;
  width: calc(100% / var(--n, 1));
  min-width: 0;
}
</style>