# 真机调试手册

这份手册只写「桌面上看不出来、只有真机才暴露」的问题。每一条都是在这台设备上
实际踩出来的，附上了当时的症状和排查顺序 —— 因为**症状比结论更重要**：
下次遇到一样的症状，照着下面几步能省掉大半时间。

> **第一次接触真机调试**，请先读 [`../../docs/AI-操作手机闭环.md`](../../docs/AI-操作手机闭环.md)。
> 那份从「这些能力到底是怎么实现的」讲起，本文是它的项目专用进阶版。
> 配套的现成命令在 `../../.opencode/skill/android-device-automation/scripts/android.mjs`。
>
> 本文只记**这个项目**特有的坑。跨项目的通用经验（58 条，含大量「不报错但
> 结果不对」的坑，以及通用排查顺序）在 [`../../docs/notes/踩坑记录.md`](../../docs/notes/踩坑记录.md)。
> 其中能机械判定的部分已挂成断言：`python scripts/verify_docs.py` 的
> 「真机交互守卫」一节（137 项）。

## 0. 先分清三种「不工作」

| 用户说的 | 实际可能是 | 怎么区分 |
|---|---|---|
| 「卡死，什么按钮都没用」 | **app 崩了**，屏幕留着最后一帧 | `adb shell pidof <包名>` —— 空就是崩了 |
| 「点了没反应」 | 事件没绑上 / 元素被盖住 | 进程活着，用 CDP 看 DOM |
| 「数据不对 / 读不到」 | 业务逻辑或数据库 | 进程活着，CDP 里查数据 |

**「卡死」十次里有八次是崩溃。** 先查崩溃，别在界面上找原因：

```bash
adb logcat -b crash -c        # 清空崩溃缓冲（-b crash，不是默认的 main）
# ……在手机上复现一次……
adb logcat -b crash -d | tail -30
adb shell pidof com.wordbank.app.debug
```

崩溃长这样（注意 `crashpad` 和 `libmonochrome`，这是 WebView 自己的库崩了）：

```
F chromium: [FATAL:crashpad_client_linux.cc:744] Render process (12342)'s crash
             wasn't handled by all associated webviews, triggering application crash.
F libc    : Fatal signal 5 (SIGTRAP) ... in tid 12342 (CrRendererMain)
```

**为什么屏幕看起来是正常的旧画面**：渲染进程死了，但系统没有立刻销毁 Activity，
屏幕上留着崩溃前那一帧 —— 于是「界面还在、就是什么都不动」。见
[`tests/WEBVIEW-CRASHES.md`](tests/WEBVIEW-CRASHES.md)。

## 1. 装一次、改一次：不要跳过重新构建

`npm run apk` 会做：vite build → 拷进 assets → gradle → adb install。

**「dist 存在就跳过构建」是个陷阱。** 它曾经让一个已知修复没进包，
本机 dev server 一切正常、手机上复现依旧 —— 排查方向整个跑偏，
直到发现 APK 里装的是旧代码。现在这个脚本**每次都重新构建**，
要复用得显式 `--skip-web`。

验证包里是新代码的方法（别靠感觉）：

```bash
grep -c '某个修复的特征串' app/web/dist/assets/*.js
adb shell ls -l /data/app/*/com.wordbank.app.debug*/base.apk   # 需要 root，通常不行
```

更靠谱的是看构建时间戳是否更新：`Get-Item app\android\app\build\outputs\apk\debug\app-debug.apk`

## 2. 看 JS 里到底发生了什么：CDP 直连

壳里没有地址栏，logcat 又收不到 `console.log`（见 §3）。
直接把调试协议连进 WebView，在里面执行任意表达式：

```bash
node app/web/tests/cdp.mjs                      # 打印当前 URL / 标题
node app/web/tests/cdp.mjs "location.hash"
node app/web/tests/cdp.mjs "document.querySelectorAll('.sense').length"
node app/web/tests/cdp.mjs "(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('wordbank');q.onsuccess=()=>r(q.result)});return [...d.objectStoreNames].join(',')})()"
```

这比截图快十倍，而且能拿到截图里看不见的东西（URL、IndexedDB 内容、
组件数量）。**遇到「界面上说不清」的问题，第一反应应该是问页面本身。**

### 「闪了一下」用逐帧录屏，不要用截图

```bash
node app/web/tests/screencast_frames.mjs "document.querySelectorAll('.sense')[0].click()" frames
```

`adb exec-out screencap` 一次几百毫秒，而闪烁只有一两帧（真机 16~37ms），
**截图必然错过**（我据此判错过一次，修了半天不是那个问题）。
`screencast_frames.mjs` 用 CDP `Page.startScreencast` 逐帧录下来，
按**字节数**判断：中间帧明显小于稳定帧就是闪了（实测闪的那帧 9 KB vs 稳定 29 KB）。

判据与两种工具的分工见 `docs/notes/踩坑记录.md` 第 29、42 条。

### socket 名必须用当前 pid 拼

```powershell
adb shell ps -A | Select-String wordbank     # 第 2 列是 pid（第 1 列是 USER，最后一列是包名）
adb forward --remove-all
adb forward tcp:9333 "localabstract:webview_devtools_remote_<pid>"
```

两个坑：
- **别从 `/proc/net/unix` 里「找一个带 devtools 的」** —— 那里会残留已退出进程的
  socket，连上 TCP 看着成功，一发 HTTP 就被关（`fetch failed`），
  很容易误判成脚本的问题。
- `ps -A` 的 pid 在**第 2 列**。取最后一列会拿到包名，拼出来的 socket 不存在。

## 3. console 日志进不了 logcat：Chromium 的过滤

`WebChromeClient.onConsoleMessage` 收不到 `console.log`，原因有两个，都很隐蔽：

1. 新 Android SDK 已经移除 `WebSettings.setLogLevel` / `LOG_LEVEL_VERBOSE`
   （编译直接报「找不到符号」）。
2. Chromium 默认只把 **ERROR/WARNING** 级的 console 转过来，LOG 级全丢。

**表现是「桥接代码写好了、日志一条都没有」，比不桥接还误导人。**

可靠做法（本项目用的）：页面把日志变成请求，壳在 `shouldInterceptRequest` 里接住：

```js
// 页面
fetch(`/__log?l=${level}&m=${encodeURIComponent(msg)}`).catch(() => {})
console.log = (...a) => { orig(...a); nativeLog('log', a) }
```
```java
// 壳：WebViewClient 和 ServiceWorkerClient 两处都要接
if ("/__log".equals(request.getUrl().getPath())) return handleLogRequest(request.getUrl());
```

浏览器里没有这个端点，请求 404 后静默忽略，开发时零开销。

## 4. 常见坑速查

| 症状 | 根因 | 判据 |
|---|---|---|
| app 崩、屏幕停在旧画面 | WebView 渲染进程崩（多半是某个 UI 库组件） | `logcat -b crash` 指向 `libmonochrome` |
| 读不到任何数据、也没报错 | Dexie schema 就地改了已发布版本 | `indexedDB.databases()` 看版本；启动跑 `verifySchema()` |
| 事务相关操作静默失败 | IndexedDB 事务外写对象库 | 抛 `NotFoundError`，把少掉的表加进 `db.transaction(...)` 的 scope |
| 写完读到的还是旧值 | 缓存没失效（用了不触发的内部事件） | 用 `table.hook('updating'|'creating'|'deleting')`，别用 `db.on('storagemutated')` |
| 打字/点按卡顿 | 每个按键都全表读 | 缓存全表 + 按表失效；`tests/perf_probe.mjs` 量化 |
| 底栏随滚动轻微抖动 | 组件库用 JS 算占位高度，安全区为 0 时算错 | 自己留白（`padding-bottom`），别用它的 placeholder |
| APK 里弹「装到手机上」 | WebView 的 display-mode 不是 standalone | UA 里有 `; wv)` 就是 WebView，别显示安装提示 |
| 键盘弹起，输入框被盖住 | 全屏壳下 WebView viewport 不压缩，网页侧测不到键盘高度 | 见 §4.1，键盘高度只能从原生 insets 拿 |

### 4.1 键盘高度：网页侧永远测不到，只能原生上报

这一条单独拎出来，因为它**骗过了所有看起来正确的方法**。

实测（屏高 800 CSS px，键盘实际占 283）：

```
键盘确实弹了    mInputShown=true，ime inset bottom=991 物理 px = 283 CSS px
JS 侧看到的    visualViewport.height = 800   innerHeight = 800
               clientHeight = 800             screen.height = 801
               ↑ 四个值全部没变，网页侧**完全无感**
```

于是 `visualViewport` 那套标准做法在 WebView 壳里必然失效：
`innerHeight - visualViewport.height - offsetTop - 60` 恒等于 0，
`--kb` 永远是 `0px`，输入框躲在键盘后面 —— 而 JS 日志里什么异常都没有。

两个必须知道的坑：

1. **`setSystemUiVisibility(LAYOUT_FULLSCREEN)` 会吞掉 IME insets。**
   全屏标志一设，ime 的 inset 被系统消费，`onApplyWindowInsets` 收不到
   ime 类型。改用 `WindowInsetsController`（API 30+）就正常了。
   但它**必须在 `setContentView` 之后**调用 —— 在 `onCreate` 开头调
   `getWindow().getInsetsController()`，内部解引用还没创建的 DecorView，
   直接 NPE 崩在启动。堆栈完全指不到原因。

2. **全屏下 WebView 尺寸不变，insets 就不会重分发。**
   `setOnApplyWindowInsetsListener` + `requestApplyInsets()` 都装好了，
   键盘弹起却一次都不回调（logcat 里一条日志都没有）。
   唯一可靠的做法是**轮询 `getRootWindowInsets()`**（250ms 一次）。

验证要这样看（只看 `kb-open` 类名不算数，得确认数值对得上）：

```bash
adb shell dumpsys input_method | Select-String mInputShown   # true = 键盘弹了
# ime inset bottom ÷ density 应与页面里的 __kbNow 相等（283 = 991/3.5）
adb logcat -d -s wordbank:* | Select-String "ime="           # 原生侧每次变化打一行
node tests/cdp.mjs "JSON.stringify({kb:__kbNow, open:document.documentElement.classList.contains('kb-open')})"
```

#### 三个连带发现（都是同一件事的连锁反应）

**① `setStatusBarColor` 在 Android 15+ 是空操作。**
targetSdk ≥ 35 强制 edge-to-edge，状态栏下方画什么它就透什么 ——
「不透明的状态栏」只能由页面自己画：一条 `position:fixed; height:var(--wb-sb-h)`
的实色带。想靠主题里写 `statusBarColor` 达到不透明效果，会发现截图里状态栏
仍是渐变透出来的。

**② 顶部留白只能算一次。**
`.wb-page` 的 `padding-top` 和 `.wb-topbar` 的 `padding-top` 都写了
`--wb-sb-h`，而 topbar 是 page 的第一个子元素 → 叠加成 `2 × 38 = 76px`，
标题被推到屏幕很下面（实测标题落在 84px，应为 46px）。
现在约定：**有 topbar 的页面由 topbar 让位，没有的（只有首页）由页面自己让。**
改完各页首个元素统一落在 44~46px。

**③ 弹层里的输入框，`window.scrollTo` 救不了。**
`window.scrollTo` 只对文档流里的元素有效，而 `van-popup` 是 `position:fixed`、
还 teleport 到 `body`。实测弹层输入框底边 671 > 键盘顶边 517，整个泡在键盘后面。
解法是给弹层自己加 `padding-bottom: var(--kb)`（贴底且高度由内容决定，
加了 padding 总高度变大、顶边就上移）。这条规则必须写在**全局**样式里 ——
写在 `.vue` 的 scoped 块里会编译成 `.kb-open[data-v-x] .van-popup[data-v-x]`，
而弹层拿不到 `data-v`，永远匹配不上（这个坑排查时看不到任何报错）。

#### 自查清单

改完键盘相关的代码，在真机上按顺序确认，别只看类名：

```bash
node tests/cdp.mjs "JSON.stringify({
  kb: __kbNow,                                  # 与 ime inset ÷ density 一致
  open: document.documentElement.classList.contains('kb-open'),
  pad: getComputedStyle(document.querySelector('.van-popup')).paddingBottom,
})"
```

- 反复点同一个输入框 ≥3 次（中间用 BACK 收键盘）—— 每次都要避让。
  「只有第一次避让」是基准值没在键盘收起时回退的经典 bug。
- 键盘开着时从 A 框点到 B 框 —— 高度没变、没有 inset 回调，只能靠 `focusin`。
- 弹层里的输入框单独测 —— 固定定位元素不吃 `scrollTo`。

## 5. 自动化巡检（省掉反复手点）

```bash
adb shell am force-stop com.wordbank.app.debug
adb logcat -b crash -c
adb shell monkey -p com.wordbank.app.debug -c android.intent.category.LAUNCHER 1
Start-Sleep 9
# 点一串坐标，每步之间给页面渲染时间
adb shell input tap 473 2650; Start-Sleep 2   # 词库
adb shell input tap 400 957;  Start-Sleep 2   # 第一个词
adb shell input tap 400 1149; Start-Sleep 3   # 第一个义项
adb shell screencap -p /sdcard/x.png
adb pull /sdcard/x.png $env:TEMP/x.png
adb shell pidof com.wordbank.app.debug         # 空 = 中途崩了
adb logcat -b crash -d | tail
```

坐标换算（别直接抄，屏幕分辨率不同比例也不同）：
截图高 2048、实际 2800 → `实际y = 截图y × 2800/2048`；宽度同理。

## 6. 不用真机也能测的东西

浏览器里跑不了的那部分，搬到 Node 里用真实代码路径测（别测复刻版）：

```bash
node app/web/tests/srs_parity.mjs      # 移植的公式与参照实现逐格比对
node app/web/tests/flow_smoke.mjs      # 数据层端到端（fake-indexeddb + esbuild 打包真实模块）
node app/web/tests/schema_upgrade.mjs  # 旧库 → 新代码的升级路径
node app/web/tests/perf_probe.mjs      # 全库规模下各交互的耗时
```

`fake-indexeddb` + `esbuild` 把 TS 打进临时文件再 import，就能让
Dexie/Vue 这类浏览器代码在 Node 里跑起来。这样**大部分 bug 不用等装机就能发现**。

## 7. 构建环境的几个 Windows 细节

```powershell
$env:JAVA_HOME="D:\software\Android\Android Studio\jbr"   # Android Studio 自带 jbr 就够
$env:ANDROID_HOME="D:\software\Android\Sdk"
adb="D:\software\Android\Sdk\platform-tools\adb.exe"
```

- `gradle.bat` 必须 `shell: true` 才能 spawn，否则 `EINVAL`。
- 找不到 gradle 时翻 `~/.gradle/wrapper/dists/` —— 装过 Android Studio 的机器上
  通常有现成的发行版，不必下载。
- `adb devices` 显示 `unauthorized` = 手机上还没点「允许 USB 调试」。
- `screencap` 提示「Multiple displays」不影响用，默认第一个屏。

## 8. 什么时候该放弃 WebView 换原生

这一轮踩到的是「某个 UI 库组件让渲染进程崩溃」。换掉那个组件能解决，
但如果**换成原生也躲不开**（比如换成 Compose 后 WebView 那一层根本不用了），
就该重新评估。

判断标准不是「崩了几次」，而是：

- 崩溃源在你的代码里（某个组件用法）→ 换掉它，继续 WebView
- 崩溃源在 Chromium 库层（`libmonochrome`、系统 WebView 版本）→ 换掉它意义不大，
  下个系统升级还会崩，这时候换原生才划算
- 需要的能力 WebView 给不了（后台任务、推送、系统级分享、深度系统 API）→ 换原生