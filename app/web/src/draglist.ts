/** 长按拖动排序。
 *
 *  为什么要自己写而不是用上下箭头按钮：
 *  箭头的致命问题不是「难用」而是「易误触」—— 它通常紧挨着删除/标记这类
 *  危险操作，一个 mini 尺寸的小按钮点错了代价很大（删掉一条例句），而且
 *  手指粗的人根本点不准。拖动的收益是**位置语义**：想去哪儿就拖着去哪儿，
 *  不需要看箭头朝哪儿，也不用点十几次。
 *
 *  交互约定（照抄系统级的做法，不然用户不会用）：
 *   · 长按 350ms 才进入拖动 —— 短按是划词、是滚动，不能抢
 *   · 长按前移动超过 8px 视为滚动，取消长按
 *   · 激活时震动一下（navigator.vibrate），确认「抓起来了」
 *   · 其他行会真的让位（transform），而不是画一根插入线
 *
 *  用 Pointer Events 而非 touch/mouse 事件：三个输入一套代码，
 *  而且 setPointerCapture 能在手指滑出元素后继续收到事件。
 */
import { computed, ref, type Ref } from 'vue'
import { toast } from './toast'

const LONG_PRESS_MS = 350
const MOVE_TOLERANCE = 8
/** 让位时额外留出的缝，让「这一行会插到这里」看得清楚 */
const GAP = 8

/**
 * 长按时给多少反馈。
 *
 * 这一步不能省：用户按住 350ms 期间页面**完全没有变化**，
 * 他无法区分「已经在拖了只是还没动」和「我按的位置不对 / 这里不能拖」。
 * 没有反馈的隐藏手势是最容易被判定为「功能没做」的设计 ——
 * 实测就会被说成「排序功能还是没有切换成拖动」。
 * 震动 + 整行抬起，是让他确信「抓起来了」的两个 cheapest 信号。
 */
const HAPTIC_MS = 18

/**
 * 拖动中每跨过一条边界震一下。
 * 比 HAPTIC_MS 更短：连续快速拖动时它会连着响，太长会变成持续嗡鸣。
 */
const CROSS_TICK_MS = 8

/** 取消拖动后，让行滑回原位所留的过渡时间 */
const SETTLE_MS = 200

export interface DragState {
  /** 正在被拖的那一行的 key */
  key: string | null
  /** 目标插入位置（索引） */
  target: number
  /** 正在拖动的行的纵向位移 */
  offset: number
}

export function useDragReorder(
  container: Ref<HTMLElement | null>,
  onReorder: (from: number, to: number) => void | Promise<void>,
) {
const key = ref<string | null>(null)
const from = ref(-1)
const to = ref(-1)
const offset = ref(0)
/** 取消拖动时的收尾阶段：样式还留着，但改成「滑回原位」的过渡 */
const settling = ref(false)

  interface RowRect {
    key: string
    top: number
    height: number
  }
  let rects: RowRect[] = []
  let pointerId = -1
  let startY = 0
  let timer = 0
  let active = false

  const dragging = computed(() => key.value != null)
  const height = computed(() => (key.value != null ? rects[from.value]?.height ?? 0 : 0))

  function measure(): void {
    const box = container.value
    if (!box) return
    const base = box.getBoundingClientRect().top
    rects = Array.from(box.querySelectorAll<HTMLElement>('[data-drag-key]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { key: el.dataset.dragKey!, top: r.top - base, height: r.height }
    })
  }

  function reset(): void {
    window.clearTimeout(timer)
    key.value = null
    from.value = -1
    to.value = -1
    offset.value = 0
    settling.value = false
    rects = []
    pointerId = -1
    active = false
    document.body.classList.remove('wb-dragging')
  }

  /** 拖动中的行跟着手指走；其余行让位到新位置 */
/** 让被拖的行也走 CSS 过渡，手指快速划过时不会生硬。 */
function styleFor(k: string, index: number): Record<string, string> {
  return computeStyle(k, index)
}

function computeStyle(k: string, index: number): Record<string, string> {
  // ★★ 必须先把响应式状态**全部读一遍**，再决定要不要 return。
  //
  //  Vue 只在渲染时「真正读到」的 ref 上建立依赖。以前这里写的是：
  //      if (!active || rects.length === 0 || key.value == null) return {}
  //  `||` 会短路 —— 初始渲染时 active 是 false，第一项就为真直接返回，
  //  key / to / offset **一个都没被读到**，于是这三个 ref 从未被订阅。
  //  后果是拖动时改它们不触发任何重渲染，用户看到的就是
  //  「只有松手后顺序才变」—— 因为松手走的是 load() 整表刷新，
  //  最终状态自然是对的，中间过程一个像素都不动。
  //
  //  这个 bug 极其安静：没有报错，控制台干净，代码看起来完全合理。
  const dragging = key.value != null && rects.length > 0 && active
  const draggedKey = key.value
  const dy = settling.value ? 0 : offset.value
  const target = settling.value ? from.value : to.value
  const origin = from.value
  const h = height.value
  const settle = settling.value
  if (!dragging && !settle) return {}

  if (k === draggedKey) {
    return {
      transform: `translateY(${dy}px) scale(1.02)`,
      zIndex: '30',
      position: 'relative',
      // 抬起 = 放大一点点 + 投影 + 变亮，让「它离开了原位」一眼可见。
      // 放大幅度刻意压到 1.02：例句行里有 contenteditable，
      // 缩放超过 1.03 光标和选区就会跟文字错位，看起来像另一条例句。
      boxShadow: settle ? 'none' : '0 10px 28px rgba(20,24,40,.22)',
      filter: settle ? 'none' : 'brightness(1.03)',
      // 取消时给一条回弹曲线；正常跟手时必须 none，否则手指会有「粘滞感」
      transition: settle ? 'transform .2s cubic-bezier(.2,.9,.3,1.2), box-shadow .2s, filter .2s' : 'none',
    }
  }
  // 让位方向：往下拖时被跨过的行整体上移，向上拖时下移
  let shift = 0
  const span = h + GAP
  if (target > origin && index > origin && index <= target) shift = -span
  else if (target < origin && index >= target && index < origin) shift = span
  if (!shift) return {}
  return {
    transform: `translateY(${shift}px)`,
    transition: settle
      ? 'transform .2s cubic-bezier(.2,.9,.3,1.2)'
      : 'transform .18s ease-out',
  }
}

  /** 用被拖行的中线反推插入位置：越过哪一行的中线，就插到那一行前面。 */
  function computeTarget(offsetY: number): void {
    if (rects.length === 0) return
    const dragged = rects[from.value]
    const mid = dragged.top + offsetY + dragged.height / 2
    let idx = rects.length - 1
    for (let i = 0; i < rects.length; i++) {
      if (mid < rects[i].top + rects[i].height / 2) {
        idx = i
        break
      }
    }
    // 跨过一条边界就轻震一下。没有它，让位的那一行是「突然」跳过去的，
    // 用户不确定是自己拖过了界还是程序出了错。震动就是「过界了」的确信。
    if (idx !== to.value) navigator.vibrate?.(CROSS_TICK_MS)
    to.value = idx
  }

  function onMove(e: PointerEvent): void {
    if (pointerId === -1 || e.pointerId !== pointerId) return
    const dy = e.clientY - startY

    if (!active) {
      // 长按还没成立就先动了 → 这是划词/滚动，放弃
      if (Math.abs(dy) > MOVE_TOLERANCE) reset()
      return
    }
    e.preventDefault()
    offset.value = dy
    computeTarget(dy)
  }

  /**
 * 松手。
 *
 *  ★ 提交时**不能先 reset 再落库**。
 *    原来的写法是 `reset(); await onReorder(f, t)`，于是顺序是：
 *       清 transform（行瞬间弹回原位）→ …几十毫秒… → 落库 + 重渲染成新顺序
 *    中间那段空窗里行是「啪」地弹回去的，快速连续换位时整列看起来在闪。
 *    真机逐帧采样抓到的实况：
 *       +1759ms  位移已清空、内容还是旧顺序
 *       +1808ms  内容才换成新顺序      ← 中间 50ms 的错位窗口
 *
 *    现在的顺序是：先让**数据**变成新顺序（onReorder 开头同步换掉本地数组），
 *    再清 transform —— 此时底层顺序已经和手指放开时看到的位置一致，
 *    去掉位移**视觉上什么都不动**，直接就是最终状态。
 *    两者发生在同一个 Vue 批次里，只渲染一次。
 */
async function onUp(e: PointerEvent): Promise<void> {
    if (pointerId === -1 || e.pointerId !== pointerId) return
    const wasActive = active
    const f = from.value
    const t = to.value
    const willCommit = wasActive && f !== t && f >= 0 && t >= 0

    if (willCommit) {
      // 故意**不 await**：onReorder 开头是同步的本地换序，
      // 紧接着 reset 会在同一个渲染批次里生效，中间没有错位帧。
      void Promise.resolve(onReorder(f, t)).catch((err) => {
        console.error('[drag] 排序落库失败', err)
        toast('排序没能保存，请重试')
      })
      reset()
      return
    }

    // 取消：让被拖的行滑回原位、让位的行滑回去。
    // 直接清会「啪」地弹回，像是出了错；滑回去才像「放开了手」。
    if (wasActive) {
      settling.value = true
      await new Promise((r) => setTimeout(r, SETTLE_MS))
    }
    reset()
  }

  /** 绑在拖动把手上（不是整行 —— 整行要留给划词和编辑） */
  function startDrag(e: PointerEvent, k: string): void {
    if (e.button !== undefined && e.button !== 0) return
    measure()
    const index = rects.findIndex((r) => r.key === k)
    if (index < 0) return
    pointerId = e.pointerId
    startY = e.clientY
    active = false
    from.value = index
    to.value = index

    timer = window.setTimeout(() => {
      active = true
      key.value = k
      document.body.classList.add('wb-dragging')
      // 震动一下当作「抓起来了」的确认。没有它，长按和滑动的区别用户感知不到
      navigator.vibrate?.(HAPTIC_MS)
      measure()
    }, LONG_PRESS_MS)

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return { key, dragging, startDrag, styleFor, reset }
}