/** 直连真机 WebView 的调试小工具（复制到项目里改包名/端口即可用）。
 *
 *  解决的问题：WebView 壳里没有地址栏，logcat 又收不到 console.log，
 *  于是「界面上看到什么」与「JS 里到底发生了什么」之间没有通道。
 *  这个脚本就是那条通道：读 URL、执行任意表达式。
 *
 *  用法：
 *      node cdp.mjs <包名>                  # 打印 URL / 标题
 *      node cdp.mjs <包名> "location.hash"
 *      node cdp.mjs <包名> "document.querySelectorAll('.item').length"
 *      node cdp.mjs <包名> "(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('wordbank');q.onsuccess=()=>r(q.result)});return [...d.objectStoreNames].join(',')})()"
 *
 *  前置：壳里开了 WebView.setWebContentsDebuggingEnabled(true)。
 *
 *  两个踩过的坑（都写在代码注释里了）：
 *    · socket 名要用当前进程 pid 拼，/proc/net/unix 里有已退出进程的残留
 *    · ps -A 的 pid 在第 2 列，最后一列是包名
 */
import { execSync } from 'node:child_process'

const PKG = process.argv[2] ?? 'com.example.app'
const EXPR = process.argv[3]
const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? 'D:/software/Android/Sdk'
const ADB = `${SDK}/platform-tools/adb.exe`
const PORT = 9333

const row = execSync(`"${ADB}" shell ps -A`, { encoding: 'utf8' })
  .split('\n')
  .find((l) => l.includes(PKG))
const pid = row?.trim().split(/\s+/)[1]
if (!pid) {
  console.error(`没找到 ${PKG} 的进程 —— 确认 app 在前台`)
  process.exit(1)
}

execSync(`"${ADB}" forward --remove-all`, { stdio: 'ignore' })
let pages = null
for (const name of [`webview_devtools_remote_${pid}`, `webview_devtools_remote_twe_${pid}`]) {
  try {
    execSync(`"${ADB}" forward tcp:${PORT} "localabstract:${name}"`, { stdio: 'ignore' })
    pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    break
  } catch {
    /* 换下一个命名 */
  }
}
const page = pages?.find((t) => t.type === 'page')
if (!page) {
  console.error(`连不上调试端口（pid=${pid}）—— 确认 setWebContentsDebuggingEnabled(true)`)
  process.exit(1)
}

console.log('URL  :', page.url)
console.log('标题 :', page.title)
if (!EXPR) process.exit(0)

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const res = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true })
ws.close()

if (res.result?.exceptionDetails) {
  console.log('抛错 :', res.result.exceptionDetails.exception?.description ?? '(见原文)')
} else {
  const v = res.result?.result?.value
  console.log('结果 :', typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}