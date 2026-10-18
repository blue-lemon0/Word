/** 用 Chrome DevTools 协议连进手机上的 WebView，直接问它问题。
 *
 *  为什么需要：壳里没有地址栏、日志又进不了 logcat（Chromium 只转
 *  ERROR/WARNING 级 console），于是「页面上看到什么」与「JS 里到底
 *  发生了什么」之间没有通道。这个脚本就是那条通道：
 *  读当前 URL、在页面里执行任意表达式、把 console 抓出来。
 *
 *  用法：
 *      node app/web/tests/cdp.mjs                     # 连上并打印状态
 *      node app/web/tests/cdp.mjs "document.title"    # 执行一段 JS
 */
import { execSync } from 'node:child_process'

const SDK = process.env.ANDROID_HOME ?? 'D:/software/Android/Sdk'
const ADB = `${SDK}/platform-tools/adb.exe`
const PORT = 9333

/* 1. 找 WebView 的调试 socket。
 *    ★ 不要从 /proc/net/unix 里「找一个包含 devtools 的」：那里会残留
 *      已退出进程的 socket（forward 过去能连上 TCP，但一发 HTTP 就被关），
 *      表现成「fetch failed」，很容易误判成脚本问题。
 *      正确做法：用当前 app 进程的 pid 拼 socket 名，两种命名都试一遍。 */
const pkg = process.argv[3] ?? 'com.wordbank.app.debug'
const psOut = execSync(`"${ADB}" shell ps -A`, { encoding: 'utf8' })
/* ps -A 的一行是：USER PID PPID ... STATE NAME
   进程号在**第 2 列**，不是最后一列（最后一列是包名）。取错列会拿包名
   去拼 socket 名，然后报「连不上」—— 看起来像调试没开，其实是解析错了。 */
const row = psOut.split('\n').find((l) => l.includes(pkg))
const pid = row?.trim().split(/\s+/)[1]
if (!pid) {
  console.error(`没找到 ${pkg} 的进程 —— 确认 app 在前台`)
  process.exit(1)
}
execSync(`"${ADB}" forward --remove-all`, { stdio: 'ignore' })
let ok = false
for (const name of [`webview_devtools_remote_${pid}`, `webview_devtools_remote_twe_${pid}`]) {
  try {
    execSync(`"${ADB}" forward tcp:${PORT} "localabstract:${name}"`, { stdio: 'ignore' })
    const r = await fetch(`http://127.0.0.1:${PORT}/json`)
    await r.text()
    ok = true
    break
  } catch {
    /* 换下一个命名 */
  }
}
if (!ok) {
  console.error(`连不上调试端口（pid=${pid}）。WebView 调试没开？确认 setWebContentsDebuggingEnabled(true)`)
  process.exit(1)
}

/* 2. 列出页面 */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('调试端口连上了，但没有页面')
  process.exit(1)
}
console.log('URL   :', page.url)
console.log('标题  :', page.title)

const expr = process.argv[2]
if (!expr) process.exit(0)

/* 3. 在页面里执行表达式并取回结果 */
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const res = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
})
ws.close()

if (res.result?.exceptionDetails) {
  console.log('抛错  :', res.result.exceptionDetails.exception?.description ?? '（见原文）')
} else {
  const v = res.result?.result?.value
  console.log('结果  :', typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}