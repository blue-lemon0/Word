# 让 AI 操作真机：能力拆解与闭环方法

> 面向第一次接触这件事的开发者。目标是让你明白：**它到底是怎么做到的、哪里靠谱、哪里不靠谱**，以及你自己怎么复现一遍。

---

## 0. 一句话概括

AI 操作手机不是「它长了手」，而是**一个可以自我验证的循环**：

```
  ① 看 ──→ ② 量 ──→ ③ 动 ──→ ④ 验 ──┐
  ↑                                     │
  └─────────────────────────────────────┘
```

- **看**：拿一张屏幕截图，用视觉理解它
- **量**：不靠眼睛估坐标，而是从程序里问出精确坐标
- **动**：用 adb 发点击 / 滑动 / 按键
- **验**：再查一次状态，确认这一步真的生效了

**第 ④ 步是全部的关键。** 没有第 ④ 步，第 ② 步的误差会一路累积，最后变成「点了七下，不知道自己在哪」；有了第 ④ 步，每一步都能纠偏。

后面所有内容都是围绕「怎么把 ④ 做好」展开的。

### 0.1 需要人介入时：先播报，再停下来等；做完了也要说一声

这条是**协作约定**，不是技术能力，但不知道就会一直踩：
有些步骤 AI 一个人做不完（要你在手机上点「允许 USB 调试」、要你审批、
或者一个长任务跑完了你需要知道）。这些节点要**先出声播报**，
再暂停等待，不要自己闷头往下做。

**两个节点都要播报，不只是开工**：

| 时机 | 为什么 |
|---|---|
| **要动手装到手机上之前** | 装包会覆盖正在用的版本，用户有权先知道 |
| **这一轮做完时** | 长任务跑完用户是听不见的，不说一声他只能干等；也可能以为你卡住了 |

```powershell
python d:\software\temp\voice_notify.py "<说清楚要人做什么>" -n 2 --beep 2
```

播报内容要写成**人可以直接照做的动作**，例如
「请解锁手机并允许 USB 调试」「构建完成，请审批安装」，
而不是「进行中」这种没有行动项的话。

收尾那句要说清**做了什么、下一步是什么**，例如
「首页首帧假话修好了，要打包安装」「做完了，改动在工作区，还没提交」。

---

## 1. 四种能力，分别是什么

### ① 视觉：看截图

**怎么做到的**：把手机的屏幕抓成一张图片，然后把图片交给一个能处理图像的模型。

```bash
adb shell screencap -p /sdcard/shot.png
adb pull /sdcard/shot.png ./shot.png
```

然后把这个 png 作为一次输入读进去。

**它擅长什么**
- 一眼看出整体布局：这块是标题、那块是列表、右上角有个按钮
- 判断「看起来对不对」：布局错位、文字被遮挡、颜色是不是太浅
- 理解文字内容（只要字别太小）

**它不擅长什么**
- **不能精确数像素**。你问它「这个按钮的中心在第几个像素」，它给的是估计值，不是测量值
- 颜色只能靠眼睛判断，拿不到 RGB 数值
- 密集小字容易认错

> **所以：截图用来「看懂」，不用来「定位」。** 定位必须靠下一节。

---

### ② 定位：拿到精确坐标（★ 最容易被忽略、也最重要）

这是新手最常踩坑的地方，我自己也踩了好几次。

**坑长这样**：

| 你手里的数 | 单位 | 这台机器上 |
|---|---|---|
| 截图上的像素 | 物理像素 | 1080 × 2400 |
| 网页里量到的坐标 | CSS 像素 | 360 × 800 |

两者差一个 **`devicePixelRatio`（本机 3.5）**。

如果你拿着 CSS 坐标直接去点：

```bash
# 错的：CSS 坐标 180,582 被当成物理坐标 → 点到了别的地方
adb shell input tap 180 582
```

**它不会报错。** 没有任何提示，只是「点了没反应」或者「点到了隔壁控件」。
你会以为是 app 的 bug，去查代码，查半天。

**正确做法：让程序去量，别自己估。**

如果被测的应用是网页（在 WebView 或浏览器里），可以直接问页面：

```js
// 在页面里执行，返回元素中心的设备坐标
(function () {
  const e = document.querySelector('.big')
  const r = e.getBoundingClientRect()
  return {
    x: Math.round((r.left + r.width / 2) * devicePixelRatio),
    y: Math.round((r.top + r.height / 2) * devicePixelRatio),
  }
})()
```

拿到之后：

```bash
adb shell input tap 630 2037
```

这套东西已经封装好了，不用自己写：

```bash
node .opencode/skill/android-device-automation/scripts/android.mjs tap ".big"
# → 已点 .big → 设备坐标 630,2037（密度 3.5）
```

> **一句话记住：任何时候都不要用「看着截图估出来的坐标」去点击。** 要么让程序量，要么用选择器。

---

### ③ 动作：发指令

```bash
adb shell input tap 630 2037              # 点击
adb shell input swipe 100 600 800 600 300 # 滑动（x1 y1 x2 y2 毫秒）
adb shell input keyevent 4                 # 返回
adb shell input text "hello"               # 输入文字（不支持中文）
adb shell am force-stop <包名>             # 杀掉
adb shell monkey -p <包名> -c android.intent.category.LAUNCHER 1   # 启动
```

**注意 `input text` 的限制**：不支持中文，也不支持空格。要输入中文得改用「剪贴板 + 长按粘贴」或者直接用 CDP（见下）往输入框里赋值。

---

### ④ 感知：怎么确认「真的生效了」

**这是决定成败的一步。** 分三个层次，可靠性递减：

#### a. 进程还在吗（最粗，但能抓住闪退）

```bash
adb shell pidof com.wordbank.app.debug
```

输出为空 = 应用已经退出。手机上看到的往往是「画面还停在崩溃前那一帧」，
因为系统不会立刻回收崩溃的 Activity —— **这就是「用户说卡死了」的真相**。

```bash
adb logcat -b crash -d     # 崩溃细节，注意 -b crash 不能省
```

#### b. 页面现在是什么样（最有用）

如果是网页应用，可以用 Chrome DevTools 协议（CDP）直接连进 WebView，
**像在浏览器控制台里一样执行 JS**。这是「看」和「量」的精确版本：

```bash
node .../android.mjs probe "location.hash"
node .../android.mjs probe "document.querySelectorAll('.chip').length"
```

能拿到的东西包括：
- 当前 URL / 路由
- DOM 结构、元素尺寸、计算样式
- 内存数据库（IndexedDB）里的真实数据
- 你自己挂在 `window` 上的任何变量

> 有个前提：原生侧要开了调试开关。
> Android 上是 `WebView.setWebContentsDebuggingEnabled(true)`。

#### c. 系统层面的状态

```bash
adb shell dumpsys input_method | grep mInputShown   # 键盘弹了没
adb shell dumpsys window | grep mCurrentFocus       # 当前是哪个界面
adb logcat -s <你的TAG>                              # 应用自己的日志
```

---

## 2. 完整走一遍

假设要验证「四个选项在手机上会不会挤出一屏」。

```bash
# 1. 重新启动，确保状态干净
adb shell am force-stop com.wordbank.app.debug
adb logcat -b crash -c                    # 先把崩溃缓冲清空
adb shell monkey -p com.wordbank.app.debug -c android.intent.category.LAUNCHER 1
sleep 9                                  # 等它渲染完（别急着点）

# 2. 进入训练页
node android.mjs probe "location.hash='#/train'"
sleep 2

# 3. 展开选项（按选择器点，不猜坐标）
node android.mjs tap ".abar button:nth-child(2)"
sleep 2

# 4. 量化「有没有溢出」—— 这是关键的一步
node android.mjs probe "(function(){
  const w = document.querySelector('.wb-wrap')
  return { 超出: w.scrollHeight - w.clientHeight }
})()"
# → {"超出": 0}  说明一屏放得下
# → {"超出": 120} 说明溢出了 120px，必须滚屏

# 5. 再看一眼截图，用眼睛确认视觉上也对
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png ./s.png

# 6. 最后确认没崩
adb shell pidof com.wordbank.app.debug     # 有 pid = 还活着
adb logcat -b crash -d                     # 空 = 干净
```

第 4 步是这个例子里真正的价值所在 —— 它把「看起来有点挤」这种模糊感受，
变成了一个可以判断真假、可写进自动化测试的数字。

---

## 3. 常见的坑（都是真的踩过的）

| 现象 | 真实原因 | 怎么确认 |
|---|---|---|
| 点了没反应 | CSS 坐标当物理坐标用了 | `devicePixelRatio` 是不是 3.5 |
| 画面不动，像卡死 | 进程已经崩了，屏幕留着旧帧 | `pidof` 为空 + `logcat -b crash` |
| 输入框被键盘盖住 | 页面不知道键盘弹了多高 | 真机上量键盘高度 vs 元素位置 |
| 日志一条都没有 | Chromium 默认只转 ERROR/WARNING 级 console | 改用主动上报或 CDP |
| JS 里量到的高度和真机不一致 | 沉浸式全屏 + adjustResize 下 viewport 不压缩 | 对比 `innerHeight` 和系统 insets |
| 固定定位的弹层不吃滚动避让 | `scrollTo` 对 `position:fixed` 无效 | `elementFromPoint` 看看落点是谁 |
| 模拟点击和真手指不一样 | adb 是注入事件，没有压力和真实手势 | 关键路径仍需人工确认 |

---

## 4. 「验」怎么做才算数 ← 这一节最容易被跳过，也最值钱

上面说「验」，但没说怎么验。**验得草率比不验更糟**：你会基于
一份错的测量得出一个自信的错误结论，然后按错误方向查半小时。

先记住一条：**先确认「我测的是不是我以为的那个东西」，再解读数据。**

### 4.1 三个「测量工具本身在骗你」的实例

都是这次真实遇到的，每一个都让我得出了错误结论：

| 你以为在测 | 实际情况 | 怎么发现 |
|---|---|---|
| 刚改的代码生效了 | 设备跑的是 8 分钟前的旧包（构建脚本被管道过滤器杀掉，没走到安装） | 对比本机 `dist` 的文件名 vs 设备上 `document.scripts` |
| 拿到了这一帧 | 被上一次崩溃残留的采样器污染，往同一个数组里推旧格式记录 | 记录格式对不上；跑之前先重启应用 |
| 键盘高度是多少 | 恒为 0（壳层把 insets 吃掉了，网页侧每个值都在骗你） | 和 `adb shell dumpsys` 的系统量并排比 |

**通用做法**：任何「测量」都先跑一个 sanity check —— 换个已知答案去校准它。
新搭的探针，第一次用之前先在一个**结果你确定**的场景上跑一遍。

### 4.2 怀疑「闪了一下」→ 必须逐帧采样

肉眼、截图、甚至单次 `getBoundingClientRect` 都会骗你：
中间状态往往只存在**一两帧**（16~32ms），全都能错过。

```js
// 在页面里逐帧记录，只记和上一帧不同的
window.__frames = []
function sample() {
  var rows = [].slice.call(document.querySelectorAll('.item'))
  var sig = rows.map(r => r.querySelector('.title').textContent).join('|')
           + ' TF:' + rows.map(r => getComputedStyle(r).transform).join(',')
  var last = window.__frames[window.__frames.length - 1]
  if (!last || last.sig !== sig) window.__frames.push({ t: performance.now(), sig })
  requestAnimationFrame(sample)
}
sample()
```

三个要点：

1. **内容与位移都要记进签名**。只记内容会漏掉「位移跳了但内容没变」，
   只记位移会漏掉「内容错了但没动」。
2. **MutationObserver 不可靠**——跨组件重渲染、teleport、`style` 属性变更
   都容易漏记或重复记。逐帧采样才记录「被画出来的那一帧」。
3. **跑完立刻断开**。忘了断开会积累残留采样器，
   下一次运行报一个看起来毫不相关的错。

这个技巧本身很普通。**值钱的是「知道什么时候该用它」**——即：
问题描述里出现「闪」「跳」「动一下」「好像不太对」这类词时。

### 4.3 函数算对了但结果没出来 → 手动调它，和渲染结果对比

这是定位响应式问题唯一可靠的办法：

```js
// 页面里同时取两个东西
[].slice.call(document.querySelectorAll('.item')).map(e => ({
  computed: getComputedStyle(e).transform,   // 实际渲染出来的
  inline: e.getAttribute('style'),            // 有没有被写进 DOM
}))
// 再手动调一次那个渲染期函数，对比两者
```

三者关系能直接定位问题在哪一层：

| 现象 | 结论 |
|---|---|
| 手动调用返回 `{}`，但内部状态是对的 | 依赖没被收集（早退分支挡住了 ref 读取） |
| 手动调用返回正确值，DOM 为空 | Vue 算出来了但没写进 DOM |
| DOM 有值但位置不对 | 纯 CSS / 布局问题 |

### 4.4 查「谁越界」「谁在挡着」→ 用 elementFromPoint

```js
// 这个点上实际会点到谁
document.elementFromPoint(x, y)
// 谁真的挡住了这个元素
document.elementsFromPoint(x, y)
```

比读 CSS 猜靠谱得多。注意 **`querySelectorAll('*')` 查不到伪元素**——
用「遍历所有元素找越界者」这类诊断时，会得到「没有越界元素」的假阴性。

### 4.5 交互问题优先量化，别用「看着挤」当判据

```js
// 内容超出可视区多少
const w = document.querySelector('.wrap')
w.scrollHeight - w.clientHeight    // 0 = 一屏放得下
```

「看起来有点挤」不是结论，`超出: 120px` 才是。而且这个数字可以直接
写成自动化断言。

## 5. 常见误区（都是这次真实踩的）

| 想法 | 为什么错 |
|---|---|
| 逐帧采样是很高深的能力 | 它就是 rAF，任何人都能做；值钱的是知道该用 |
| 构建日志说 SUCCESSFUL，说明装上了 | 日志可能被管道过滤器截断，安装根本没执行 |
| 我写的代码没问题，一定是环境/工具的问题 | 上面三次「环境问题」里有两次是我的代码 |
| MutationObserver 记下来的就是全部变化 | 会漏 teleport、style 属性和跨组件重渲染 |
| 遍历 DOM 就能找出越界元素 | 伪元素不在 DOM 树里 |
| 看截图能看出闪没闪 | 中间态可能只有一两帧 |

自动化不是万能的，下面这些情况请老老实实手动点：

- **需要真实手势的**：长按拖动排序、多指缩放、边缘滑动返回
- **涉及支付、授权、隐私弹窗的**
- **视觉正确性才是重点的时候**（比如「这个配色好不好看」）—— 数字判断不了审美
- **只跑一次的调试**：为了点三下而写一百行自动化脚本，不划算

它的正确用法是：**把「反复要做的、能量化的验证」自动化**，把「一次性的、需要判断的」留给人。

---

## 6. 你自己复现的最小步骤

1. 手机开「开发者选项」→ 「USB 调试」
2. USB 连电脑，手机上点「允许」
3. `adb devices` 确认能看到设备
4. `adb shell screencap -p /sdcard/a.png && adb pull /sdcard/a.png` —— 先确认能看到屏幕
5. 装个和你 app 同源的例子：`node android.mjs launch` / `state` / `shot` / `probe`

如果第 4 步就失败，问题在 USB 调试那一层，跟本文无关。

---

## 相关文件

- `docs/notes/踩坑记录.md` —— **60 条「不报错但结果不对」的坑**，每条含症状/真因/判据/避免，
  以及通用排查顺序。本文讲方法，那份是实例。
- `app/web/DEBUG-RUNBOOK.md` —— 本项目的真机排查手册（本文的进阶版）
- `.opencode/skill/android-device-automation/` —— 可直接复用的工具与说明
- `app/web/tests/cdp.mjs` —— 本项目用的 CDP 工具
- `scripts/verify_docs.py` —— 把能机械判定的坑写成断言（当前「真机交互守卫」141 项）