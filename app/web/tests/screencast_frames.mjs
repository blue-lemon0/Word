/** 逐帧录屏 —— 专门用来判断「切页面时到底闪没闪、闪出了什么」。
 *
 *  为什么需要：`adb exec-out screencap` 一次要几百毫秒，而闪烁只有**一两帧**
 * （真机实测 16~37ms），截图必然错过 —— 我为此用肉眼和普通截图各判错一次。
 * CDP 的 `Page.startScreencast` 是逐帧推过来的，能覆盖整个过渡。
 *
 *  怎么读结果：**看每帧的文件大小**。稳定帧之间字节数接近；中间若出现一个
 *  明显偏小的帧（比如 9 KB vs 稳定 29 KB），那就是闪的那一帧，打开看内容。
 *  这比逐帧签名更直接 —— 签名告诉你「闪的是什么」，字节数告诉你「还闪不闪」。
 *
 *  用法：
 *      node app/web/tests/screencast_frames.mjs <触发切换的 JS> [输出目录]
 *      node app/web/tests/screencast_frames.mjs "document.querySelectorAll('.sense')[0].click()" frames
 *
 *  注意：触发必须是**真实用户路径**。用 CDP 里的 `element.click()` 测
 *  「需要用户手势」的功能（文件选择等）会得到假阴性（见踩坑记录 34）。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const SDK = process.env.ANDROID_HOME ?? 'D:/software/Android/Sdk'
const ADB = `${SDK}/platform-tools/adb.exe`
const PORT = 9334
const pkg = process.env.ANDROID_PKG ?? 'com.wordbank.app.debug'
const outDir = process.argv[3] ?? 'frames'

/* 1. 连上 WebView 的调试端口。socket 名要用**当前 pid**，别去 /proc/net/unix 里翻 */
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
if (!page) {
  console.error('调试端口连上了，但没有页面')
  process.exit(1)
}

/* 2. 开始收帧 */
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
const frames = []
const t0 = Date.now()

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

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Page.enable')
await send('Page.startScreencast', {
  format: 'jpeg',
  quality: 70,
  maxWidth: 540,
  maxHeight: 1200,
  everyNthFrame: 1,
})

/* 3. 等 1 秒让录制稳定，再触发切换 —— 这个时刻就是 before/after 的分界 */
await new Promise((r) => setTimeout(r, 1000))
const mark = Date.now() - t0
await send('Runtime.evaluate', {
  expression: process.argv[2] ?? "location.hash='#/word/reply'",
  awaitPromise: true,
  returnByValue: true,
})
await new Promise((r) => setTimeout(r, 1200))
await send('Page.stopScreencast')

/* 4. 落盘并报告：最小的 after 帧就是最可疑的那一帧 */
mkdirSync(outDir, { recursive: true })
const written = frames.map((f, i) => {
  const tag = f.dt < mark ? 'before' : 'after'
  const name = `${String(i).padStart(3, '0')}-${f.dt}ms-${tag}.jpg`
  writeFileSync(`${outDir}/${name}`, Buffer.from(f.data, 'base64'))
  return { name, kb: Math.round(Buffer.from(f.data, 'base64').length / 1024) }
})
ws.close()

const after = written.filter((f) => f.name.includes('after'))
const sizes = after.map((f) => f.kb)
const min = Math.min(...sizes)
const typical = sizes[Math.floor(sizes.length / 2)]
console.log(`抓到 ${frames.length} 帧（切换在第 ${mark}ms 左右）→ ${outDir}/`)
console.log(
  `after 帧大小：最小 ${min} KB / 常见 ${typical} KB —— ` +
    (min < typical * 0.6
      ? `★ 最小帧只有常见帧的 ${Math.round((min / typical) * 100)}%，很可能闪了，先看它`
      : '没有明显偏小的帧，应该没闪'),
)