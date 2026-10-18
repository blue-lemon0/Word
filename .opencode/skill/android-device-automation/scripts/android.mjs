#!/usr/bin/env node
/**
 * android.mjs —— 操作真机 Android 的最小闭环工具集。
 *
 * 为什么要有这个文件
 * ------------------
 * 让人（和 AI）操作手机最大的成本不是「点一下」，而是**点哪儿**：
 *   · 截图是像素坐标（这台机器 1080×2400），页面里量到的是 CSS 坐标（360×800），
 *     两者差一个 devicePixelRatio（3.5）。直接拿 CSS 坐标去 adb input tap，
 *     点的位置完全是乱的，而且**不报错** —— 只是没反应，极难察觉。
 *   · 纯靠肉眼看截图估坐标，误差百分之几；点到相邻控件上时更难发现。
 * 所以这里把换算收进工具：`tap "选择器"` 直接点到元素中心。
 *
 * 用法
 * ----
 *   node android.mjs launch [包名]          启动应用并等待渲染
 *   node android.mjs state  [包名]          进程是否活着 / 崩溃缓冲区 / 当前界面
 *   node android.mjs shot   [文件名.png]    截图并拉到本地
 *   node android.mjs probe  "<JS表达式>"   在 WebView 里执行 JS 并打印结果
 *   node android.mjs rect   "<CSS选择器>"  打印元素矩形（CSS + 物理两种坐标）
 *   node android.mjs tap    "<CSS选择器>"  点元素中心（自动换算密度）
 *   node android.mjs tapxy  <x> <y>       按 **CSS 坐标**点（自动换算密度）
 *   node android.mjs swipe  <x1> <y1> <x2> <y2> [毫秒]   按 CSS 坐标滑动
 *   node android.mjs key    <键码>         发送按键（4=返回 111=ESC 66=回车…）
 *   node android.mjs text   "<字符串>"      输入文本
 *   node android.mjs logs   [过滤词]       抓 logcat
 *
 *   包名默认取环境变量 ANDROID_PKG，没有就用 com.wordbank.app.debug。
 *   坐标一律按 **CSS 像素**填，工具负责乘密度 —— 这样在��密度手机之间通用。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SDK = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? 'D:/software/Android/Sdk'
const ADB = `${SDK}/platform-tools/adb.exe`
const DEFAULT_PKG = process.env.ANDROID_PKG ?? 'com.wordbank.app.debug'
const PORT = Number(process.env.CDP_PORT ?? 9333)

function adb(args, quiet = false) {
  return execSync(`"${ADB}" ${args}`, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : undefined })
}

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/** 包名可以是第 N 个参数，也可以来自环境变量 */
function pkgOf(args) {
  return args[0] ?? DEFAULT_PKG
}

/** 当前 app 的 pid；没在跑返回 null（这是判断「闪退」最直接的信号） */
function pidOf(pkg) {
  try {
    const out = adb('shell ps -A')
    const row = out.split('\n').find((l) => l.includes(pkg))
    return row?.trim().split(/\s+/)[1] ?? null
  } catch {
    return null
  }
}

/**
 * 连进 WebView 的 DevTools。
 *
 * 两个坑（都会表现成「连不上」，但原因完全不同）：
 *  1. socket 名要用**当前进程的 pid**，不能去 /proc/net/unix 里随便找一个 ——
 *     那里混着已退出进程留下的死 socket，能 forward 成功但 HTTP 直接被关。
 *  2. ps -A 的一行是「USER PID PPID … NAME」，pid 在**第 2 列**，
 *     不是最后一列（最后一列是包名）。取错列就会拿包名去拼 socket 名。
 */
async function connect(pkg) {
  const pid = pidOf(pkg)
  if (!pid) die(`没找到 ${pkg} 的进程 —— 应用可能没启动，或已经闪退`)
  try {
    adb('forward --remove-all', true)
  } catch {
    /* 没有 forward 规则时会报错，忽略 */
  }
  for (const name of [`webview_devtools_remote_${pid}`, `webview_devtools_remote_twe_${pid}`]) {
    try {
      adb(`forward tcp:${PORT} "localabstract:${name}"`, true)
      const r = await fetch(`http://127.0.0.1:${PORT}/json`)
      await r.text()
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {
      /* 试下一个命名 */
    }
  }
  die(`连不上调试端口（pid=${pid}）。原生侧需要 setWebContentsDebuggingEnabled(true)`)
}

/** 在页面里执行任意 JS，取回 JSON 结果 */
async function evaluate(page, expr) {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++seq
      pending.set(id, res)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const out = await send('Runtime.evaluate', {
    // 必须 await 表达式再 stringify。直接 JSON.stringify(promise) 是**同步**求值，
    // 得到的是 "{}" —— 表现为「所有异步查询都返回空对象」，而且不报错。
    // （异步返回 awaitPromise:true 也救不了：那时 promise 已经被 stringify 过了。）
    expression:
      '(async function(){ try { return JSON.stringify(await (' +
      expr +
      ')) } catch(e) { return JSON.stringify({__err:String(e)}) } })()',
    returnByValue: true,
    awaitPromise: true,
  })
  // 必须等 close 事件真的完成再返回。不等的话进程会先退出，
  // libuv 收尾时抛 "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"，
  // 看起来像是脚本本身崩了，其实只是 WebSocket 还没关干净。
  await new Promise((res) => {
    ws.addEventListener('close', res, { once: true })
    ws.close()
  })
  const v = out.result?.result?.value
  return v === undefined ? null : JSON.parse(v)
}

/** 设备像素密度。截图坐标 = CSS 坐标 × 它。 */
async function density(page) {
  return (await evaluate(page, 'devicePixelRatio')) ?? 1
}

/** CSS 坐标 → 设备坐标（四舍五入） */
async function toDevice(page, x, y) {
  const d = await density(page)
  return { x: Math.round(x * d), y: Math.round(y * d) }
}

/* ── 子命令 ── */

const [, , cmd, ...args] = process.argv

switch (cmd) {
  case 'launch': {
    const pkg = pkgOf(args)
    adb(`shell am force-stop ${pkg}`)
    // monkey 启动 launcher intent；比 am start 稳（有些包没有 activity 名字）
    adb(`shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, true)
    await new Promise((r) => setTimeout(r, 6000))
    const pid = pidOf(pkg)
    console.log(pid ? `已启动，pid=${pid}` : `启动后没有进程 —— 大概率崩了`)
    if (!pid) console.log('崩溃详情：adb logcat -b crash -d')
    break
  }

  case 'state': {
    const pkg = pkgOf(args)
    const pid = pidOf(pkg)
    const crash = adb('logcat -b crash -d', true).trim()
    let focus = ''
    try {
      focus = adb('shell dumpsys window', true)
        .split('\n')
        .find((l) => l.includes('mCurrentFocus'))
        ?.trim()
    } catch {
      /* 某些 ROM 没有 dumpsys window */
    }
    console.log(`进程     : ${pid ?? '（没有 —— 已退出/闪退）'}`)
    console.log(`崩溃缓冲 : ${crash ? `${crash.split('\n').length} 行，需检查` : '空（干净）'}`)
    console.log(`前台界面 : ${focus ?? '未知'}`)
    if (crash) console.log(crash.split('\n').slice(0, 20).join('\n'))
    break
  }

  case 'shot': {
    const name = args[0] ?? 'shot.png'
    adb('shell screencap -p /sdcard/_shot.png', true)
    const local = join(tmpdir(), name)
    try {
      rmSync(join(tmpdir(), '_prev.png'), { force: true })
    } catch {
      /* 忽略 */
    }
    adb(`pull /sdcard/_shot.png "${local}"`, true)
    console.log(local)
    break
  }

  case 'probe': {
    const page = await connect(pkgOf([]))
    console.log('URL   :', page.url)
    console.log('标题  :', page.title)
    console.log('结果  :', JSON.stringify(await evaluate(page, args.join(' '))))
    break
  }

  case 'rect': {
    const sel = args.join(' ')
    const page = await connect(pkgOf([]))
    const d = await density(page)
    const info = await evaluate(
      page,
      `(function(){
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom),
                 left: Math.round(r.left), width: Math.round(r.width),
                 height: Math.round(r.height),
                 text: (e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40) };
      })()`,
    )
    if (!info) die(`没找到元素：${sel}`)
    const cx = info.left + info.width / 2
    const cy = (info.top + info.bottom) / 2
    console.log(JSON.stringify(info))
    console.log(`CSS 中心 : ${Math.round(cx)}, ${Math.round(cy)}`)
    console.log(`设备坐标 : ${Math.round(cx * d)}, ${Math.round(cy * d)}   (密度 ${d})`)
    break
  }

  case 'tap': {
    const sel = args.join(' ')
    const page = await connect(pkgOf([]))
    const d = await density(page)
    const info = await evaluate(
      page,
      `(function(){
        const e = document.querySelector(${JSON.stringify(sel)});
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: (r.left+r.width/2)*devicePixelRatio, y: (r.top+r.height/2)*devicePixelRatio };
      })()`,
    )
    if (!info) die(`没找到元素：${sel}`)
    const px = Math.round(info.x)
    const py = Math.round(info.y)
    adb(`shell input tap ${px} ${py}`, true)
    console.log(`已点 ${sel} → 设备坐标 ${px},${py}（密度 ${d}）`)
    break
  }

  case 'tapxy': {
    // 关键：参数是 CSS 坐标，工具负责换算。手写容易漏这一步而「点了没反应」。
    const page = await connect(pkgOf([]))
    const d = await density(page)
    const x = Number(args[0])
    const y = Number(args[1])
    if (Number.isNaN(x) || Number.isNaN(y)) die('用法：tapxy <x> <y>（CSS 坐标）')
    const px = Math.round(x * d)
    const py = Math.round(y * d)
    adb(`shell input tap ${px} ${py}`, true)
    console.log(`CSS(${x},${y}) → 设备(${px},${py})，密度 ${d}`)
    break
  }

  case 'swipe': {
    const page = await connect(pkgOf([]))
    const d = await density(page)
    const [x1, y1, x2, y2] = args.map(Number)
    const ms = Number(args[4] ?? 300)
    const p = [x1, y1, x2, y2].map((v) => Math.round(v * d))
    adb(`shell input swipe ${p[0]} ${p[1]} ${p[2]} ${p[3]} ${ms}`, true)
    console.log(`CSS(${x1},${y1})→(${x2},${y2}) 设备(${p.join(' ')})`)
    break
  }

  case 'key': {
    adb(`shell input keyevent ${args[0] ?? 4}`, true)
    console.log(`已发送按键 ${args[0] ?? 4}`)
    break
  }

  case 'text': {
    // adb input text 不支持空格和中文，先做编码
    const raw = args.join(' ')
    const ascii = raw.replace(/[^\x20-\x7e]/g, '')
    if (ascii) adb(`shell input text "${ascii}"`, true)
    console.log(ascii ? `已输入 ${ascii}` : '只含非 ASCII 字符，adb input text 不支持，改用 CDP 赋值')
    break
  }

  case 'logs': {
    const filter = args.join(' ')
    console.log(filter ? adb(`logcat -d -s ${filter}`) : adb('logcat -d'))
    break
  }

  default:
    console.log(`android.mjs —— 子命令：
  launch [包名]        启动应用并等待
  state  [包名]        进程 / 崩溃缓冲 / 前台界面
  shot   [文件名]      截图并拉到本地
  probe  "<JS>"        在 WebView 里执行 JS
  rect   "<选择器>"    元素矩形（CSS + 设备两种坐标）
  tap    "<选择器>"    点元素中心（自动换算密度）
  tapxy  <x> <y>       按 CSS 坐标点
  swipe  <x1> <y1> <x2> <y2> [ms]
  key    <键码>        4=返回 111=ESC 66=回车
  text   "<字符串>"
  logs   [过滤]
包名默认取环境变量 ANDROID_PKG（当前 ${DEFAULT_PKG}）`)
}