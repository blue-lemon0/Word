/** PWA 安装与运行环境。
 *
 *  三件事：
 *   1. 注册 service worker（只注册构建产物，dev 下不注册 —— 否则 HMR 会
 *      被缓存卡住，改了代码看不到效果）
 *   2. 捕获浏览器的安装提示（beforeinstallprompt），给一个自己的按钮
 *   3. iOS 没有这个事件，只能教用户「分享 → 添加到主屏幕」
 */

/** 已作为独立 app 运行（从主屏幕图标点进来的） */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: minimal-ui)').matches ||
    iosStandalone
  )
}

/** 运行在 Android WebView 里（也就是装成 APK 的那条线）。
 *
 *  WebView 的 display-mode **不是** standalone —— 所以光看 isStandalone()
 *  会在 APK 里也弹「装到手机上」，而用户明明已经在 app 里了，看着像脑子坏了。
 *  WebView 的 UA 一定带 `; wv)`（W...View），这是最省事的判据。 */
export function isWebView(): boolean {
  if (typeof navigator === 'undefined') return false
  return /;\s*wv\)/.test(navigator.userAgent)
}

/** iOS Safari（含 iPadOS 桌面 UA）—— 它的安装路径和别家不一样 */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOSUA = /iPad|iPhone|iPod/.test(ua)
  // iPadOS 13+ 报自己是 Mac，用触点数区分
  const iPadOS = /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1
  return iOSUA || iPadOS
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

/** 订阅「是否可安装」的状态变化，返回退订函数 */
export function onInstallable(fn: () => void): () => void {
  listeners.add(fn)
  fn()
  return () => listeners.delete(fn)
}

export async function registerSW(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.register(
      new URL('sw.js', document.baseURI).href,
      { scope: './' },
    )
    reg.addEventListener('updatefound', notify)
  } catch (e) {
    console.warn('[pwa] service worker 注册失败（不影响使用，只是不能离线）', e)
  }
}

/** 主动触发安装弹窗；不支持时返回 false（调用方该显示 iOS 指引） */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const ev = deferred
  deferred = null
  notify()
  await ev.prompt()
  const choice = await ev.userChoice
  return choice.outcome === 'accepted'
}

/** 初始化：装 beforeinstallprompt / appinstalled 监听。返回「能不能装」的判定 */
export function initPwa(): () => boolean {
  if (typeof window === 'undefined') return () => false
  window.addEventListener('beforeinstallprompt', (e) => {
    // 不 preventDefault 的话 Chrome 的自动弹窗会照常出现（有些版本要阻止）
    e.preventDefault()
    deferred = e as unknown as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
  return () => deferred != null
}