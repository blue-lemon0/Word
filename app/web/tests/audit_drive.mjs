/** 真机驱动：跑一遍「AI 体检」，每遇到提议就点「应用」，跑完报告进度。
 *
 *  ★ 这是**花钱**的脚本（每个词一次真实调用，缓存命中的免费），所以没进
 *    `npm test`，只在手动验证时用。
 *
 *  为什么用 CDP 而不是 adb 点坐标：体检是「跑一个词 → 弹浮层 → 点应用 → 下一个」，
 *  节奏由网络决定（每个词几秒到几十秒）。坐标点击得靠猜时序，而这里可以直接
 *  问 DOM「现在有没有『应用 N 条』这个按钮」。
 *
 *  用法（先确保 app 在前台、AI 已配置）：
 *      node app/web/tests/audit_drive.mjs [最大点击次数]
 */
import { execSync } from 'node:child_process'

const SDK = process.env.ANDROID_HOME ?? 'D:/software/Android/Sdk'
const ADB = `${SDK}/platform-tools/adb.exe`
const PORT = 9344
const MAX = Number(process.argv[2] ?? 30)

const psOut = execSync(`"${ADB}" shell ps -A`, { encoding: 'utf8' })
const row = psOut.split('\n').find((l) => l.includes('com.wordbank.app.debug'))
const pid = row?.trim().split(/\s+/)[1]
if (!pid) {
  console.error('没找到 app 进程 —— 先把它打开')
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
  console.error('连不上 WebView 调试端口')
  process.exit(1)
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('没有页面')
  process.exit(1)
}

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

const expr = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const btns = () => [...document.querySelectorAll('button')]
  const byText = (re) => btns().find((b) => re.test((b.textContent || '').trim()))
  const log = []
  // 先确保在体检页并开跑
  if (!/AI 体检/.test(document.body.innerText)) {
    location.hash = '#/audit'
    await sleep(2500)
  }
  const started = byText(/开始体检|再跑一遍/)
  if (!started) return 'NO_START_BUTTON: ' + document.body.innerText.slice(0, 200)
  started.click()
  let applied = 0
  for (let i = 0; i < ${MAX * 40}; i++) {
    await sleep(2500)
    const txt = document.body.innerText
    const applyBtn = byText(/^应用 \\d+ 条$/)
    if (applyBtn) {
      const n = Number((applyBtn.textContent.match(/\\d+/) || [0])[0])
      applyBtn.click()
      applied += n
      log.push('apply:' + n)
      await sleep(600)
      continue
    }
    const applyOne = byText(/^只应用这条$/)
    if (applyOne && /AI 体检/.test(txt) === false) { /* 不会发生 */ }
    if (/这一轮过完了/.test(txt)) { log.push('done'); break }
    if (/出错|连不上|没余额|余额不足|调用太频繁/.test(txt)) { log.push('ERROR'); break }
    log.push('tick')
  }
  const m = document.body.innerText.match(/已过\\s*(\\d+)/)
  return JSON.stringify({ applied, read: m ? Number(m[1]) : null, tail: log.slice(-3) })
})()`

const res = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
})
ws.close()
if (res.result?.exceptionDetails) {
  console.error('抛错：', res.result.exceptionDetails.exception?.description)
  process.exit(1)
}
console.log('结果：', res.result?.result?.value)
