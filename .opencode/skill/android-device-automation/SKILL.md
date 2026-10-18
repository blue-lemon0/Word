---
name: android-device-automation
description: 操作真机 Android 做验证与排查。看截图、量精确坐标、点击滑动、读页面状态、查崩溃日志。当需要「在手机上验证一下」「真机点一下」「看看布局有没有溢出」「应用是不是闪退了」时使用。也适用于任何 WebView / PWA 应用的自动化验证。
---

# 真机 Android 自动化

给 AI（或人）在真机上验证 UI 的闭环工具。核心原则：**看 → 量 → 动 → 验**，
其中「量」必须由程序给出精确坐标，「验」必须有，否则坐标误差会累积到无法定位问题。

## 什么时候用

- 改了 UI，要确认「在真机上到底长什么样、有没有溢出」
- 要复现/确认一个「只有真机才出现」的问题（渲染崩溃、键盘遮挡、WebView 差异）
- 要做一条可重复跑的验证流程，避免每次都手点

## 不适合

- 真实手势（长按拖动、多指缩放）
- 支付 / 授权 / 隐私弹窗
- 只跑一次的调试（写脚本的成本高于手点）
- 视觉审美判断（量化不了）

## 前置条件

```bash
adb devices          # 必须能看到设备，否则下面都免谈
```

应用是网页（WebView 或浏览器）时，原生侧需要开调试开关，否则用不了 `probe` / `tap`：
- Android：`WebView.setWebContentsDebuggingEnabled(true)`
- 其它平台：Chrome 远程调试

## 包名

默认取环境变量 `ANDROID_PKG`，没设就是 `com.wordbank.app.debug`：

```bash
export ANDROID_PKG=com.example.app     # Linux/macOS
$env:ANDROID_PKG="com.example.app"     # PowerShell
```

## 命令

```bash
S=.opencode/skill/android-device-automation/scripts/android.mjs

node $S launch              # 启动并等 6 秒；没进程就说明崩了
node $S state               # 进程 / 崩溃缓冲 / 前台界面
node $S shot out.png        # 截图（物理像素，1080×2400 这类）
node $S probe "<JS>"        # 在 WebView 里执行 JS，打印 JSON
node $S rect  "<选择器>"     # 元素矩形，同时给出 CSS 与设备两种坐标
node $S tap   "<选择器>"     # 点元素中心（自动乘密度）
node $S tapxy <x> <y>       # 按 CSS 坐标点
node $S swipe <x1> <y1> <x2> <y2> [ms]
node $S key   4             # 4=返回 111=ESC 66=回车
node $S text  "hello"       # 仅 ASCII，不支持中文
node $S logs  <TAG>
```

## 三条铁律

### 1. 永远不要用截图上目测的坐标点击

截图是**物理像素**（本机 1080×2400），页面里量到的是 **CSS 像素**（360×800），
差一个 `devicePixelRatio`（本机 3.5）。拿 CSS 坐标直接 `adb input tap`：

```bash
adb shell input tap 180 582      # 错，点到了别处，而且不报错
adb shell input tap 630 2037     # 对
```

用 `tap "<选择器>"` 让工具换算，或者先 `rect` 看清两种坐标。

### 2. 每一步之后都要验，不要靠「应该成功了吧」

```bash
node $S tap ".big"
node $S probe "location.hash"     # ← 必须确认
node $S state                     # ← 顺便看进程还活着没
```

`pidof` 为空 = 已闪退（手机上看起来像「画面卡住不动」）。
`adb logcat -b crash -d` 看细节，`-b crash` 不能省。

### 3. 判断「有没有超出屏幕」要用数字，不要靠眼睛

```bash
node $S probe "(function(){
  const w = document.querySelector('.wb-wrap')
  return { 超出: w.scrollHeight - w.clientHeight }
})()"
```

「超出: 0」是硬结论；「看起来有点挤」不是。

### 4. 怀疑「闪了一下」→ 逐帧采样

中间状态常常只存在一两帧（16~32ms），肉眼、截图、单次采样都会错过。
在页面里挂 rAF，只记和上一帧不同的：

```js
window.__frames = []
function sample(){
  var rows = [].slice.call(document.querySelectorAll('.item'))
  // 内容与位移都要进签名：只记一个会漏掉另一半的问题
  var sig = rows.map(r=>r.querySelector('.t').textContent).join('|')
           + ' TF:' + rows.map(r=>getComputedStyle(r).transform).join(',')
  var last = window.__frames[window.__frames.length-1]
  if (!last || last.sig !== sig) window.__frames.push({t: Math.round(performance.now()), sig})
  requestAnimationFrame(sample)
}
sample()
```

跑完**立刻断开**，否则残留的采样器会污染下一次运行。

### 5. 先确认「我测的是不是我以为的那个东西」

**验得草率比不验更糟**——你会基于错的测量得出自信的错误结论。
新搭的探针，第一次用之前先在一个**结果你确定**的场景上校准一遍。

本次真实踩到的三个「测量工具在骗我」：

| 你以为 | 实际 | 怎么发现 |
|---|---|---|
| 刚改的代码生效了 | 设备跑的是旧包 | 对比本机 dist 文件名 vs `document.scripts` |
| 拿到了这一帧 | 被上次残留的采样器污染 | 记录格式对不上；跑前先重启应用 |
| 键盘高度是多少 | 恒为 0（壳层吃了 insets） | 和 `adb shell dumpsys` 的系统量并排比 |

## 排查顺序（app 在真机上出问题）

```bash
node $S state                          # 1. 进程还在吗
adb logcat -b crash -d                 # 2. 崩了吗
node $S probe "location.href"          # 3. 页面在哪
node $S probe "typeof window.__bridge" # 4. 原生桥在吗
adb shell dumpsys input_method | grep mInputShown   # 5. 键盘弹了吗
```

## 已知坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `连不上调试端口` | WebView 调试没开，或进程已死 | 开 `setWebContentsDebuggingEnabled(true)`，先看 `state` |
| `没找到进程` | 应用没启动 / 已闪退 | `adb logcat -b crash -d` |
| `没找到元素` | 页面没到那个路由 / 元素在弹层里（弹层 teleport 到 body） | 先 `probe "location.hash"` 确认在哪 |
| console 无日志 | Chromium 只转 ERROR/WARNING 级 | 主动 `fetch('/__log?...')` 上报，或用 `probe` |
| 键盘遮挡输入框 | 全屏壳下网页侧量不到键盘高度 | 只能原生 insets 上报，见 `web-app-to-native` skill |
| 固定定位弹层不吃滚动避让 | `scrollTo` 对 `position:fixed` 无效 | 给弹层自己加 `padding-bottom: var(--kb)` |

## 配套文档

`docs/AI-操作手机闭环.md` —— 讲清楚每种能力能做什么、不能做什么，适合入门阅读。