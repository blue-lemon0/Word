import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import HomePage from './pages/HomePage.vue'
import WordPage from './pages/WordPage.vue'
import SensePage from './pages/SensePage.vue'
import LibraryPage from './pages/LibraryPage.vue'
import BoardPage from './pages/BoardPage.vue'
import TrainPage from './pages/TrainPage.vue'
import MorePage from './pages/MorePage.vue'
import { VANT_COMPONENTS } from './vant'
import { ensureSeeded } from './seed'
import { sweepTrash, verifySchema, warmTables } from './db'
import { initPwa, registerSW } from './pwa'
import { toast } from './toast'

/* hash 路由：PWA 离线时不需要服务端做 history fallback，
 *  直接 index.html#/word/xxx 也能打开。
 *
 *  ★ `meta: { tab: true }` = 「我是一个 tab 页，底部要摆导航栏」。
 *    **只有这三个有**。注意「训练」不在里面：
 *    训练是**一个动作**，不是一个地方 —— 摆在 tab 栏里是分类错误
 *    （和 D35 里「详情页不该摆底栏」同一类毛病）。
 *    它从首页的「去训练」进去，盖满全屏、没有底栏、有返回。
 *
 *    为什么默认隐藏、而不是列一张「要隐藏的路径」：
 *    手维护前缀表的失败是**静默**的（加新页面忘了加，底栏就露出来了），
 *    默认隐藏的失败只是「新 tab 页少写一行」—— 见 App.vue 的说明。 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage, meta: { tab: true } },
    { path: '/word/:word', name: 'word', component: WordPage, props: true },
    { path: '/sense/:id', name: 'sense', component: SensePage, props: true },
    { path: '/library', name: 'library', component: LibraryPage, meta: { tab: true } },
    { path: '/board', name: 'board', component: BoardPage },
    { path: '/train', name: 'train', component: TrainPage },
    { path: '/more', name: 'more', component: MorePage, meta: { tab: true } },
  ],
})

const app = createApp(App)
VANT_COMPONENTS.forEach((c) => app.use(c))
app.use(router)

/**
 * 原生壳在 IME insets 变化时调 window.__wbKbInset(cssPx)。
 *
 * 必须在这里、也就是挂载**之前**就把钩子装好：第一次
 * onApplyWindowInsets 发生在页面刚加载时，晚了就漏掉第一次 ——
 * 键盘已经弹起来了，页面却以为它没弹，输入框正好躲在键盘后面。
 * keyboard.ts 注册监听时会读这里攒下来的当前值。
 */
if (typeof window !== 'undefined') {
  const w = window as unknown as {
    __wbKbInset?: (px: number) => void
    __kbListeners?: Array<(px: number) => void>
    __kbNow?: number
  }
  const listeners: Array<(px: number) => void> = []
  w.__kbListeners = listeners
  w.__kbNow = 0
  w.__wbKbInset = (px: number) => {
    w.__kbNow = px
    for (const fn of listeners) fn(px)
  }
}

/* ── 真机调试基建 ──
 * 壳里没有地址栏，真机出问题时看不到当前 URL，也看不到 JS 报错 ——
 * 排查只能靠猜。这段把 console 转发成 fetch('/__log?...')，壳的
 * shouldInterceptRequest 接住打进 logcat；查的时候 adb logcat -s wordbank:*。
 *
 * 为什么不靠 WebChromeClient.onConsoleMessage：新 Android SDK 已经移除
 * WebSettings.setLogLevel，而 Chromium 默认只转 ERROR/WARNING 级 console，
 * console.log 全被丢掉 —— 表现是「桥接写好了、日志一条都没有」。
 * 浏览器里没有这个端点，请求 404 后静默忽略，开发时零开销。
 */
function nativeLog(level: string, args: unknown[]): void {
  try {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ')
    void fetch(`/__log?l=${encodeURIComponent(level)}&m=${encodeURIComponent(msg)}`, {
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    /* 日志通道坏了也不能影响应用 */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const orig = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    orig(...args)
    nativeLog(level, args)
  }
}

router.afterEach((to) => {
  console.log('[route]', to.fullPath, JSON.stringify(to.params))
})
router.onError((e) => {
  console.error('[router]', String(e))
})
app.config.errorHandler = (err, _inst, info) => {
  console.error('[vue]', info, String(err))
}
window.addEventListener('error', (e) => console.error('[window]', e.message))
window.addEventListener('unhandledrejection', (e) => console.error('[promise]', String(e.reason)))

// 种子必须在挂载前灌完，否则词库页会先闪一下「空」。
// 包在 async IIFE 里而不是用顶层 await —— esbuild 的默认 target
// （chrome87/safari14）不支持顶层 await，直接 await 会构建失败。
;(async () => {
  // 先探 schema：它坏了的话后面每个功能都会静默失败，先把话说清楚
  const check = await verifySchema()
  if (!check.ok) {
    console.error('[boot] 库结构与应用不匹配 —— 下列功能会不可用：', check.error)
    toast('数据库结构不匹配，请清数据重装或联系维护者', 8000)
  }
  await ensureSeeded()
  // 回收站里的东西只留 30 天：超期自动清掉（连例句与熟练度）。
  // 不做的话「30 天可还原」就只是句安慰话。
  try {
    const n = await sweepTrash()
    if (n) console.info(`[boot] 回收站清掉 ${n} 条超 30 天的义项`)
  } catch (e) {
    console.warn('[boot] 回收站清理失败', e)
  }
  // ★ 把常用表读进内存，让每一次跳转的**首帧**就有完整内容。
  //   不 await：它只影响「跳转那一下闪不闪」，不影响首屏（首屏要什么会自己等
  //   同一个 promise，cached() 会去重）。人从打开 app 到第一次点击至少几百毫秒，
  //   早就热了。详见 db.ts 的 cachedNow / warmTables。
  void warmTables()
  // 只注册构建产物：dev 下 vite 自己管缓存，注册 SW 会把 HMR 卡住
  initPwa()
  if (import.meta.env.PROD) await registerSW()
  app.mount('#app')
})()
