/**
 * 橡皮筋探针 —— 量「越界拖动时，固定栏到底动不动」。
 *
 *  为什么要能量：肉眼判断不了这件事。越界拖动只有一两帧，
 *  `adb screencap` 一次几百毫秒必然错过（见坑 29 / 坑 42）。
 *  而结论必须是**数字**：「tabbar 移动了 3px」和「tabbar 一动没动」
 *  决定要不要改代码，肉眼只会给出「好像飘了一下」。
 *
 *  量两样，缺一不可：
 *  1. **DOM 位移** —— 连着采样 `.fixed`（底栏）与 `.sb`（状态栏实色带）
 *     的 getBoundingClientRect().top。DOM 动没动，是网页侧能改的部分。
 *  2. **合成器位移** —— CDP Page.startScreencast 逐帧录下来，
 *     同一时刻帧与帧之间底栏位置变了、而 DOM 数字没变 ⇒ 动的是**窗口**，
 *     不是文档。网页侧无能为力，只能在原生关掉。
 *
 *  用法：
 *      node app/web/tests/overscroll_probe.mjs doc  down
 *      node app/web/tests/overscroll_probe.mjs doc  up
 *      node app/web/tests/overscroll_probe.mjs sheet down   # 需先在真机上打开底部弹层
 *
 *  判读见 docs/decisions/D34-固定栏与橡皮筋.md。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const SDK = process.env.ANDROID_HOME ?? 'D:/software/Android/Sdk'
const ADB = `${SDK}/platform-tools/adb.exe`
const PORT = 9336
const pkg = process.env.ANDROID_PKG ?? 'com.wordbank.app.debug'
const dir = process.argv[4] ?? 'frames-over'
const up = (process.argv[3] ?? 'down') === 'up'
/** 要测的滚动容器：默认文档（root scroller），传 sheet 则测弹层里那个 .sh-b */
const scroller = process.argv[2] ?? 'doc'

/** 三个固定/滚动容器的上沿。fixed 与 sb 是「不该动」的，sh-b 是「该弹」的那个。 */
const MEASURE = `(function(){
  function top(sel){var e=document.querySelector(sel);if(!e)return null;
    return Math.round(e.getBoundingClientRect().top*100)/100}
  return [top('.fixed'), top('.sb'), top('.sh-b')]
})()`

/* ── 连上 WebView 调试端口（socket 名要用当前 pid）── */
const ps = execSync(`"${ADB}" shell ps -A`, { encoding: 'utf8' })
const pid = ps.split('\n').find((l) => l.includes(pkg))?.trim().split(/\s+/)[1]
if (!pid) {
  console.error(`没找到 ${pkg} 的进程 —— 确认 app 在前台`)
  process.exit(1)
}
execSync(`"${ADB}" forward --remove-all`, { stdio: 'ignore' })
let ok = false
for (const name of [`webview_devtools_remote_${pid}`, `webview_devtools_remote_twe_${pid}`]) {
  try {
    execSync(`"${ADB}" forward tcp:${PORT} "localabstract:${name}"`, { stdio: 'ignore' })
    await (await fetch(`http://127.0.0.1:${PORT}/json`)).text()
    ok = true
    break
  } catch {
    /* 换下一个命名 */
  }
}
if (!ok) {
  console.error('连不上调试端口 —— WebView 调试没开？')
  process.exit(1)
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page')

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
const frames = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  } else if (msg.method === 'Page.screencastFrame') {
    frames.push({ dt: Date.now() - t0, data: msg.params.data })
    send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {})
  }
})
function send(method, params = {}) {
  const id = ++seq
  return new Promise((res) => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) {
    console.error('页面里报错了：', r.result.exceptionDetails.exception?.description ?? expression)
  }
  return r.result?.result?.value
}

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Page.enable')
const t0 = Date.now()
await send('Page.startScreencast', {
  format: 'jpeg',
  quality: 60,
  maxWidth: 360,
  maxHeight: 800,
  everyNthFrame: 1,
})

/* 先滚到能越界的那个端点，然后停 700ms 让惯性散掉 */
const box = scroller === 'sheet' ? "document.querySelector('.sh-b')" : 'document.documentElement'
const scrollBox =
  `(function(){var e=${box};if(!e)return 0;e.scrollTop=${up ? 'e.scrollHeight' : '0'};return 1})()`
if (scroller === 'sheet' && !(await evalJs("!!document.querySelector('.sh-b')"))) {
  console.error('没找到 .sh-b —— 先在真机上打开一个底部弹层')
  process.exit(1)
}
await evalJs(scrollBox)
await new Promise((r) => setTimeout(r, 700))

const geo = await evalJs(`(function(){
  var e=${box}
  return { fixed: 0, sb: 0,
    scrollY: Math.round(e.scrollTop),
    max: Math.round(e.scrollHeight - e.clientHeight),
    h: e.clientHeight || innerHeight, sh: e.scrollHeight,
    osY: getComputedStyle(e).overscrollBehaviorY,
    rootY: getComputedStyle(document.documentElement).overscrollBehaviorY }
})()`)

/* 连着采样 700ms：上沿一旦变，就是这个元素被拖动了 */
const samples = []
const sampling = (async () => {
  for (let i = 0; i < 70; i++) {
    samples.push(await evalJs(MEASURE))
    await new Promise((r) => setTimeout(r, 10))
  }
})()

/* 真手势：从端点继续往回拖，快速 swipe —— 越界就发生在这里 */
const [x1, y1, x2, y2] = up ? [180, 500, 180, 150] : [180, 300, 180, 650]
for (let i = 0; i < 3; i++) {
  execSync(`"${ADB}" shell input swipe ${x1} ${y1} ${x2} ${y2} 120`)
}
await sampling
await send('Page.stopScreencast')

mkdirSync(dir, { recursive: true })
frames.forEach((f, i) =>
  writeFileSync(
    `${dir}/${String(i).padStart(3, '0')}-${f.dt}ms.jpg`,
    Buffer.from(f.data, 'base64'),
  ),
)
ws.close()

const nums = (arr) => arr.filter((v) => typeof v === 'number')
const spread = (idx) => {
  const v = nums(samples.map((s) => s[idx]))
  return v.length ? Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100 : null
}
const label = ['底栏 .fixed', '状态栏 .sb', '弹层体 .sh-b']
console.log(`测的是 ${scroller === 'sheet' ? '弹层里的 .sh-b' : '文档（root scroller）'}`)
console.log(
  `可视 ${geo.h}px / 内容 ${geo.sh}px / 可滚 ${geo.max}px，` +
    `overscroll-behavior-y：被测=${geo.osY} html=${geo.rootY}`,
)
console.log(`越界拖动 ${dir}/ 抓到 ${frames.length} 帧，DOM 采样 ${samples.length} 次`)
const names = ['scrollTop 变化', ...label.map((l) => `${l} 位移`)]
const moves = [geo.scrollY, spread(0), spread(1), spread(2)]
names.forEach((n, i) => console.log(`  ${n.padEnd(14)}: ${moves[i] === null ? '未找到' : moves[i] + ' px'}`))
const barsMoved = (spread(0) ?? 0) > 0 || (spread(1) ?? 0) > 0
console.log(
  barsMoved
    ? '  ⇒ 固定栏在 DOM 里被拖动了 —— 这是 overscroll 没禁干净的证据。'
    : '  ⇒ DOM 里的固定栏**一动没动**。屏幕上若真有位移，动的是合成器/窗口（网页侧看不到）。',
)