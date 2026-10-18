/** 键盘感知与避让 —— 移动端最容易被忽略、也最影响「能不能用」的一件事。
 *
 *  问题：手机上输入框在页面下半部分时，键盘一弹出来就把输入框盖住了。
 *  用户看到的是「点了没反应」，实际是「输入框在键盘下面」。
 *  这个坑在桌面上完全看不出来，一到真机就必现。
 *
 * 两种壳的键盘信号完全不同，必须都认：
 *
 *  A. 浏览器 / PWA：监听 `visualViewport`。键盘弹起时它的高度会变小，
 *     差值就是键盘高度（要减掉 offsetTop —— iOS 上键盘弹出时页面本身
 *     还会往上滚）。
 *
 *  B. 我们的 APK 壳：开了 LAYOUT_FULLSCREEN + adjustResize，WebView 的
 *     viewport **不会**被压缩。真机实测键盘占了 283px，而
 *     visualViewport.height / innerHeight / clientHeight 全都还是 800 ——
 *     网页侧每一个值都在骗人，键盘高度只能从原生 insets 拿。
 *     原生在 insets 变化时主动调 window.__wbKbInset(cssPx)。
 *
 * 两条都写进同一个 `--kb` CSS 变量，各页面据此让位。
 *
 * 避让走**全局 focusin**，不是逐个输入框挂钩子：
 *   · 页面里输入框太多（搜索、编辑、导入、标记…），逐个挂一定会漏；
 *   · 还有一个逐个挂法根本覆盖不到的情况 —— 键盘已经开着，用户从
 *     「英文例句」点到「中文翻译」。这时键盘高度**没有变化**，
 *     监听 --kb 的回调不会触发，但第二个框同样在键盘下面。
 *     focusin 能覆盖这个场景，这才是真正的全局做法。
 */
import { ref, watch } from 'vue'

/** 键盘高度（CSS px），0 表示键盘收着 */
export const keyboardInset = ref(0)

/** 键盘是否弹出 */
export const keyboardOpen = () => keyboardInset.value > 80

let started = false

function apply(px: number): void {
  keyboardInset.value = px
  document.documentElement.style.setProperty('--kb', `${px}px`)
  document.documentElement.classList.toggle('kb-open', px > 80)
}

/** 视口上沿留一点余量（状态栏实色带 + 一点呼吸），下沿同理 */
const TOP_GAP = 12
const BOTTOM_GAP = 12

/**
 * 避让对象覆盖：不是「聚焦的那个元素」而是某个更大的容器。
 *
 * 例句编辑时需要保证**整行**留在键盘上方：只保证聚焦的英文那行可见的话，
 * 它的译文和「改好了」按钮正好压在键盘下面 —— 用户得先收键盘才收得了尾，
 * 看起来就是「点了没反应」。
 */
let avoidTarget: Element | null = null

export function setAvoidTarget(el: Element | null): void {
  avoidTarget = el
}

/** 把被挡住的元素往上挪；已经露出来了就不动页面。
 *
 *  ★ 只挪「被挡住的那一点」，绝不整段重定位。
 *    原来的算法是 `scrollY + box.top - overflow - 8`：它把元素**顶部**
 *    当成了基准，元素只被键盘盖住 2px 时也会往上滚三百多 px ——
 *    真机上的表现就是「一碰输入框页面就窜到最顶上」，键盘明明只占了
 *    不到一半屏幕，内容却被推得跑出视口（scrollY 被 clamp 到 0，
 *    于是「刚打开的这一屏」整个被换掉）。
 *    现在的算法只有三步：算差多少 → 夹到合法滚动区间 → 滚那一点。
 */
export function keepVisible(el: Element | null | undefined, delay = 320): void {
  if (!el) return
  setTimeout(() => {
    const node = (avoidTarget?.isConnected ? avoidTarget : el) as HTMLElement
    // 元素可能已被卸载（v-if 掉了）
    if (!node.isConnected) return
    // 弹层里的输入框不用滚页面：弹层自己靠 padding-bottom 让位
    // （见 style.css 的 .kb-open .van-popup）。这时再滚页面只会把弹层
    // 背后的东西挪走 —— 表现为「一打字，后面那屏就乱跳」。
    //
    // 判的是**聚焦的那个元素**（el），不是替换后的避让目标：
    // 覆写目标在页面里（例句那一行），但它替的可能是弹层里的输入框，
    // 拿目标去判就会漏掉这一种。
    if (el instanceof HTMLElement && el.closest('.van-popup')) return

    const box = node.getBoundingClientRect()
    // 键盘上沿；键盘收起时它就是视口下沿
    const limit = window.innerHeight - keyboardInset.value - BOTTOM_GAP
    const h = box.bottom - box.top

    let delta: number
    if (h > limit - TOP_GAP) {
      // 比可用区还高（多行输入 + 大键盘）：露出顶部就认了，别再折腾
      delta = box.top - TOP_GAP
    } else if (box.bottom > limit) {
      delta = box.bottom - limit // 下沿被盖住：往下挪正好那么多
    } else if (box.top < TOP_GAP) {
      delta = box.top - TOP_GAP // 上沿被切掉：往上挪正好那么多
    } else {
      return // 全都在可见区里，一个像素都不动
    }

    // 页面能滚的合法区间：键盘弹出后 .wb-page 的 padding-bottom 加了 --kb，
    // 所以最大滚动位置也跟着变大 —— 不夹住就会滚到「文档底」以外。
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    const target = Math.min(Math.max(window.scrollY + delta, 0), max)
    if (Math.abs(target - window.scrollY) < 1) return
    window.scrollTo({ top: target, behavior: 'smooth' })
  }, delay)
}

/** 当前聚焦的输入元素 */
let focused: HTMLElement | null = null

export function watchKeyboard(): void {
  if (started || typeof window === 'undefined') return
  started = true

  const w = window as unknown as {
    __wbKbInset?: (px: number) => void
    __kbListeners?: Array<(px: number) => void>
    __kbNow?: number
  }

  const isEditable = (el: EventTarget | null): boolean =>
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

  // 键盘已经开着时切到另一个输入框：高度没变，没有 inset 回调可等，
  // 只能直接在 focusin 上避让一次。
  document.addEventListener(
    'focusin',
    (e) => {
      if (!isEditable(e.target)) return
      focused = e.target as HTMLElement
      if (keyboardInset.value > 80) keepVisible(focused, 120)
    },
    true,
  )
  document.addEventListener('focusout', () => {
    focused = null
  })

  // 键盘弹起时避让。
  // 基准值 last 每次都无条件更新：之前写成 `if (kb <= last) return`，
  // 键盘收起时（283→0）命中提前返回、last 停在 283 不回退，于是第二次
  // 弹起时 `283 <= 283` 又命中 —— 表现就是「只有第一次点击会避让」。
  let last = 0
  watch(keyboardInset, (kb) => {
    const rising = kb > last
    last = kb
    if (rising) keepVisible(focused, 360)
  })

  // A. 原生壳：订阅它推来的 insets 高度（唯一可信的来源）
  if (w.__kbListeners && typeof w.__wbKbInset === 'function') {
    w.__kbListeners.push((px) => apply(Math.max(0, Math.round(px))))
    apply(Math.max(0, Math.round(w.__kbNow ?? 0)))
    return
  }

  // B. 浏览器 / PWA：visualViewport
  const vv = window.visualViewport
  const update = () => {
    const height = vv ? vv.height : window.innerHeight
    const top = vv ? vv.offsetTop : 0
    // +60 的容差：地址栏收起 / 工具条出现也会改高度，不该被当成键盘
    apply(Math.max(0, Math.round(window.innerHeight - height - top - 60)))
  }
  if (vv) {
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
  }
  update()
}