/** 吸附翻页容器（scroll-snap）：把「页码 ↔ 滚动位置」的同步收在一处。
 *
 *  为什么需要它（坑 58/62/71 的家族病）：
 *  KeepAlive 只缓存组件状态，DOM 摘下再插回来时滚动位置归零。
 *  于是每个「用滚动位置当页码」的容器都背着同一条义务 ——
 *  onActivated 里把位置按页码放回去。义务散在各页面里靠人记，
 *  同一页加第二个容器时就漏了（坑 71：横滑放了、竖滑没放，
 *  可视页和 idx 错位 → 整页空白只剩底栏按钮）。
 *
 *  ★ 核心模型（坑 74 的教训）：**页码只在滚动落定后更新**。
 *  「滚动位置」和「页码」是两个数据源，靠事件同步；smooth 动画沿途的
 *  每个位置都是「过去」，谁拿它回写页码谁就引入抖动 —— 前一版用
 *  动画闸（animTarget）打补丁，真机上帧率一低照样穿（翻到一半、
 *  按钮闪没）。所以规则只有一条：
 *    onScroll 只认**正好停在页边界**的位置（snap 保证静止时必在边界）；
 *    动画途中、甩动途中一律不认。页码变了 onPage 才触发 ——
 *    作答状态重置、窗口式渲染重排，全都发生在新页落地那一刻，
 *    动画全程 DOM 一动不动。
 *
 *  代价与对策：页码落地才变，但窗口式渲染（Math.abs(i-idx)<=1）的目标页
 *  在动画途中必须是**已渲染**的，否则滑过去的是空壳。所以 pager 额外
 *  暴露 intent（程序化翻页的目标页），窗口取 page 与 intent 的并集。
 *
 *  连点（「下一题」点点点）：goBy 基于 intent 累进，不等上一次落地，
 *  点三下翻三页，落地一次结算。
 *
 *  ★ 第二条不变量（坑 74 真机「翻一半停住」的根治）：**容器尺寸不许把页码甩丢**。
 *  页边界 = clientHeight 的整数倍。落定那一刻如果触发布局变化（比如底栏收矮、
 *  容器长高 41px），所有 snap 点整体搬家，而 smooth 动画的目标值是按旧页高
 *  烤死的 —— 动画爬到旧目标停下，那里已经不是 snap 点，真机 WebView 不会
 *  重吸附，滚动永久卡在两页之间（页码却早已落定，「页码到了画面没到」）。
 *  所以 ResizeObserver 盯着容器：尺寸一变立即重建对齐 —— 动画在飞就朝
 *  intent 重新发车（新页高算新目标），静止就直接跳回当前页边界。
 */
import { nextTick, onActivated, onUnmounted, ref, watch } from 'vue'
import type { Ref } from 'vue'

export interface SnapPager {
  /** 绑到模板：ref 到容器元素（与页面里同名 ref 变量对齐即可） */
  el: Ref<HTMLElement | null>
  /** 落定页码。只在滚动停在页边界时变化；goTo 立即写仅限非 smooth。 */
  page: Ref<number>
  /** 程序化翻页的目标页（动画途中非 null）。窗口式渲染要把它包进去。 */
  intent: Ref<number | null>
  /** 视觉页码（坑 81）：每次 scroll 都更新为「当前最近的页」，不触发 onPage。
   *  连续快速甩动时 page 要等落定才变，若渲染窗口只锚 page，
   *  甩过窗口外的页全是空壳 —— 窗口必须跟着视线走。 */
  visual: Ref<number>
  /** 绑到模板：@scroll.passive="pager.onScroll" */
  onScroll: () => void
  /** 翻到第 n 页（默认 smooth 动画；页码落地才变） */
  goTo: (n: number, smooth?: boolean) => void
  /** 相对翻页（连点累进基于 intent，不被未落地的动画卡住） */
  goBy: (delta: number, smooth?: boolean) => void
}

export interface SnapPagerOptions {
  /** 页码上限（含）。默认不限。 */
  max?: () => number
  /** 落定页码变化时回调（重置作答状态之类的页面私事） */
  onPage?: (n: number) => void
}

export function useSnapPager(axis: 'x' | 'y', opts: SnapPagerOptions = {}): SnapPager {
  const el = ref<HTMLElement | null>(null)
  const page = ref(0)
  const intent = ref<number | null>(null)
  const visual = ref(0)

  const size = (): number => {
    const e = el.value
    if (!e) return 1
    return (axis === 'x' ? e.clientWidth : e.clientHeight) || 1
  }
  const clamp = (n: number): number =>
    Math.min(Math.max(n, 0), Math.max(opts.max?.() ?? Number.MAX_SAFE_INTEGER, 0))

  function setPage(n: number): void {
    const v = clamp(n)
    visual.value = v
    if (v === page.value) return
    page.value = v
    opts.onPage?.(v)
  }

  function onScroll(): void {
    const e = el.value
    if (!e || !e.isConnected) return // 摘下时的归零事件不是用户翻页
    const pos = axis === 'x' ? e.scrollLeft : e.scrollTop
    const s = size()
    const r = Math.round(pos / s)
    /* 视线先行（坑 81）：不管落没落定，先让渲染窗口知道我们在第几页附近 */
    visual.value = clamp(r)
    /* 只认落定：snap 容器静止时必停在页边界附近。阈值要容得下分数像素
       累积 —— 355.33px 的页高翻 5 页能差出 ~2px（实测），2px 阈值会让
       跨页连跳永远落不定、页码卡死；6px 以内都算落定。动画/甩动途中
       偶尔扫过边界 6px 内会提前一帧结算，后续事件会再校正，无害。 */
    const off = Math.abs(pos - r * s)
    if (off >= 6) return
    intent.value = null
    setPage(r)
  }

  function goTo(n: number, smooth = true): void {
    const t = clamp(n)
    const e = el.value
    if (!smooth) {
      intent.value = null
      setPage(t)
      if (!e) return
      const offset = t * size()
      if (axis === 'x') e.scrollLeft = offset
      else e.scrollTop = offset
      return
    }
    intent.value = t
    if (!e) return
    e.scrollTo({
      ...(axis === 'x' ? { left: t * size() } : { top: t * size() }),
      behavior: 'smooth',
    })
  }

  function goBy(delta: number, smooth = true): void {
    goTo((intent.value ?? page.value) + delta, smooth)
  }

  /* KeepAlive 回来时 DOM 重插、滚动位置归零（坑 62/71）：按页码放回去。
     直接赋值不走过场动画，onScroll 的落定判定会自然收下这个位置。 */
  onActivated(() => {
    void nextTick(() => {
      const e = el.value
      if (!e) return
      const offset = page.value * size()
      if (axis === 'x') e.scrollLeft = offset
      else e.scrollTop = offset
    })
  })

  /* 尺寸守卫（坑 74 根治，原理见文件头「第二条不变量」）：
     容器一变高/变宽，页边界整体搬家 —— 立即按新尺寸重建对齐。
     动画在飞（intent 非空）就朝目标页重新发车，scrollTo 会顶掉旧动画；
     静止就直接跳回当前页边界，onScroll 收下 off≈0 的位置，页码不变。

     ★ 挂载必须用 watch(el)，不能写在 onMounted 里（坑 79）：
     容器若被 v-if/v-else 拆掉重挂（比如「组题…」加载态和列表互斥），
     ref 会指向**新元素**，而 onMounted 里那只 RO 还在盯已下葬的旧节点 ——
     守卫看起来在、其实不在，尺寸变了永远不触发。watch(el) 换元素就重挂。 */
  let ro: ResizeObserver | null = null
  let lastSize = 0

  function attach(e: HTMLElement | null): void {
    ro?.disconnect()
    ro = null
    if (!e || !e.isConnected || typeof ResizeObserver === 'undefined') return
    lastSize = size()
    ro = new ResizeObserver(() => {
      const cur = el.value
      if (!cur || !cur.isConnected) return // KeepAlive 摘下时的零尺寸不是布局变化
      const s = size()
      if (s === lastSize) return
      lastSize = s
      if (intent.value != null) goTo(intent.value)
      else goTo(page.value, false)
    })
    ro.observe(e)
  }

  // flush:post —— 等 DOM 真正换完再挂，attach 拿到的才是新元素
  watch(el, (e) => attach(e), { flush: 'post' })

  onUnmounted(() => {
    ro?.disconnect()
    ro = null
  })

  return { el, page, intent, visual, onScroll, goTo, goBy }
}
