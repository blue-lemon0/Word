---
name: web-app-to-native
description: 把已有的 Web 应用（前端 + 浏览器端存储）打包成装到手机上的 app（Android APK / PWA），并排查真机上「只有真机才出现」的问题。当用户提到「做成 app 装到手机」「APK」「PWA」「手机上用」「WebView 白屏/卡死/崩溃」「装机后不工作」时使用。包含：assets 映射到虚拟 https 域名的正确做法、打包脚本必须每次重建前端、渲染进程崩溃的识别与定位、CDP 直连真机 WebView、Dexie/IndexedDB 在 WebView 里的坑。
---

# 把 Web 应用装到手机上

## 什么时候用这条路

用户有一个能跑的 Web 应用（React/Vue/Svelte…），想在手机上像原生 app 一样用。

两条路，先选：

| | **WebView 壳（APK）** | **PWA** |
|---|---|---|
| 前提 | 无（本地打包） | **必须 HTTPS 或 localhost** |
| 离线 | 天生离线（assets 在包里） | 需要 service worker |
| iPhone | 做不了 | 唯一出路 |
| 后台任务/推送 | 不行 | 不行 |
| 装起来像不像 app | 完全一样 | 一般 |
| 崩溃风险 | 有（Chromium 层，见下） | 无 |

**局域网 `http://192.168.x.x:5180` 装不了 PWA** —— Chrome 不注册 service worker，
「添加到主屏幕」只是个书签，没有全屏也没有离线。用户会以为是自己操作错了。

## 一、WebView 壳：三个必须做对的点

### 1. assets 挂到**虚拟 https 域名**，不能用 file://

```java
WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
    .setDomain("appassets.androidplatform.net")
    .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
    .build();
web.loadUrl("https://appassets.androidplatform.net/index.html");
```

必须是 `https`：`crypto.randomUUID`、service worker、部分存储 API 全都要求
secure context，用 `file://` 会一片一片地静默失效。

`addPathHandler("/")` + 构建产物放 `assets/` 根，这样 URL 映射正好对上：

```
/index.html            → assets/index.html
/assets/index-xxx.js   → assets/assets/index-xxx.js   ← 构建产物里自带 assets/ 子目录
```

**路径前缀多一层或少一层都会得到 `ERR_INVALID_RESPONSE`**，
而 Vant/Vue 之类的前端在 dev server 上完全正常，只有装到壳里才炸。

### 2. ServiceWorkerController 必须设

```java
if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
    ServiceWorkerControllerCompat sw = ServiceWorkerControllerCompat.getInstance();
    sw.setServiceWorkerClient(new ServiceWorkerClientCompat() {
        @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest r) {
            return loader.shouldInterceptRequest(r.getUrl());   // ← 少了这行：SW 的请求打不到 assets
        }
    });
}
```

不设的后果很隐蔽：SW 注册成功（看着一切正常），但 SW 自己发的请求拿不到资源，
离线能力反而被这层 SW 弄坏。

### 3. DOM storage 不开 = 装上没有数据

```java
s.setJavaScriptEnabled(true);
s.setDomStorageEnabled(true);   // IndexedDB 依赖它，不开就是「装了没数据」
```

### 4. 开调试（至少 debug 构建）

```java
WebView.setWebContentsDebuggingEnabled(true);
web.setWebChromeClient(new WebChromeClient() {
    @Override public boolean onConsoleMessage(ConsoleMessage m) { return true; }
});
```

注意 `console.log` 大概率**收不到**（见「排查」一节），开它是必要不充分。

## 二、打包脚本：每次都必须重建前端

```js
// ✅ 正确
await viteBuild()

// ❌ 危险：装上上个版本的代码，本机 dev 一切正常，手机上复现依旧
if (!existsSync('dist/index.html')) await viteBuild()
```

这不是理论风险。真的发生过：已知修复没进包 → 排查方向整个跑偏 →
最后发现 APK 里是旧代码。

同理，拷进 assets 前**先清空目录**，否则残留文件会让你在手机上看到
「明明改了却没变、重新装就好了」。

## 三、真机排查：先分清三种「不工作」

| 用户说的 | 实际 | 查 |
|---|---|---|
| 「卡死，什么都没用」 | **app 崩了**，屏幕留最后一帧 | `adb shell pidof <包>` 空 = 崩了 |
| 「点了没反应」 | 事件/遮挡 | 进程活着 → CDP 查 DOM |
| 「数据不对」 | 业务/数据库 | 进程活着 → CDP 查数据 |

**「卡死」多数是崩溃。** 先查崩溃，别在界面上找：

```bash
adb logcat -b crash -c      # 清空（-b crash！默认的 main buffer 里没有）
# 复现一次
adb logcat -b crash -d | tail -30
```

渲染进程崩溃的特征（注意是 Chromium 自己的库，不是你的代码）：

```
F chromium: [FATAL:crashpad_client_linux.cc:744] Render process (12342)'s crash
             wasn't handled by all associated webviews, triggering application crash.
F libc    : Fatal signal 5 (SIGTRAP) ... (CrRendererMain)
```

**加组件后的规矩：先在真机上点一遍。** 桌面上跑得好好的不算数。
记录哪些 UI 库组件会崩（本项目：`van-dropdown-menu`），
新增组件时优先怀疑「浮层 + 滚动监听 + 大量 JS 测量」这一类。

## 四、CDP 直连真机 WebView

壳里没有地址栏、logcat 又收不到 console 时，直接问页面本身。
比截图快十倍，能拿到 URL、IndexedDB 内容、DOM 结构。

```powershell
# socket 名要用当前 pid 拼
adb shell ps -A | Select-String <包名>     # pid 在第 2 列！不是最后一列（那是包名）
adb forward --remove-all
adb forward tcp:9333 "localabstract:webview_devtools_remote_<pid>"
# 然后 http://127.0.0.1:9333/json 拿 webSocketDebuggerUrl，用 Runtime.evaluate 执行表达式
```

**别从 `/proc/net/unix` 里找一个带 devtools 的** —— 那里有已退出进程的残留 socket，
TCP 连得上但 HTTP 立刻被关，表现为 `fetch failed`，很容易误判成脚本问题。

要一个现成脚本就用 `scripts/cdp.mjs`（复制到你的项目改包名即可）。

## 五、console 进不了 logcat：两个都踩过的坑

1. 新 SDK 移除了 `WebSettings.setLogLevel` / `LOG_LEVEL_VERBOSE`（编译不过）
2. Chromium 默认只转 ERROR/WARNING 级 console，LOG 级全丢

表现是「桥接写好了、日志一条都没有」，**比不桥接还误导人**。

可靠做法：把日志变成请求，壳在 `shouldInterceptRequest` 里接住。
`WebViewClient` 和 `ServiceWorkerClient` **两处都要接**。

```js
// 页面（monkey patch console）
const orig = console.log.bind(console)
console.log = (...a) => { orig(...a); fetch(`/__log?m=${encodeURIComponent(a.join(' '))}`).catch(()=>{}) }
```

```java
if ("/__log".equals(request.getUrl().getPath())) {
    Log.d("mytag", request.getUrl().getQueryParameter("m"));
    return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
}
```

浏览器里没这个端点，404 后静默忽略，开发时零开销。

## 六、IndexedDB 在 WebView 里的坑

| 症状 | 根因 | 修 |
|---|---|---|
| 读不到数据、**也不报错** | schema 就地改了已发布的 `version(1)` | 加 `version(2).stores(...)`，旧定义保留 |
| 某个写操作静默失败 | IndexedDB 事务 scope 是硬的，事务外写抛 `NotFoundError` | 少哪个表就加进 `db.transaction('rw', ...)` 的参数 |
| 写完读到的还是旧值 | 缓存失效用了 `db.on('storagemutated')`（内部事件，可能不触发） | 用公开的 `table.hook('creating'\|'updating'\|'deleting')` |
| 打字卡顿 | 每按键一次全表读 | 全表读做内存缓存，按表失效 |

第一条尤其坑：老用户的库里没有新表、代码又以为有，于是所有读写静默失败，
而现象是「某个功能坏了」，极难联想到根因。**schema 只能追加版本。**

## 七、不用装机就能测

把浏览器代码搬到 Node 里跑，用的是**真实模块**（不是复刻版）：

```js
// tests/entry.ts 把 src 下的模块按命名空间导出
export * as db from '../src/db'
// 测试里 esbuild 打包成临时 mjs 再 import
import { build } from 'esbuild'
await build({ entryPoints: ['tests/entry.ts'], outfile: tmp, bundle: true, format: 'esm' })
const M = await import(pathToFileURL(tmp).href)
```

配 `fake-indexeddb` 让 Dexie 能在 Node 里跑。这样**大部分 bug 不用等装机**。

三条值得常备的用例：
- 数据层端到端（种子导入 → 编辑 → 出题 → 备份回滚）
- 移植公式与参照实现逐格比对（数值漂移不会报错，只会悄悄变慢）
- **旧库 → 新代码的升级路径**（`schema_upgrade` 那类，见上）

## 八、Windows 构建细节

```powershell
$env:JAVA_HOME="D:\software\Android\Android Studio\jbr"  # 自带 jbr 就够
$env:ANDROID_HOME="D:\software\Android\Sdk"
```

- `gradle.bat` 必须 `shell: true` 才能 spawn，否则 `EINVAL`
- 没装 gradle 的话翻 `~/.gradle/wrapper/dists/`，装过 Android Studio 的机器上常有现成的
- `adb devices` 显示 `unauthorized` = 手机上还没点「允许 USB 调试」
- `screencap` 报「Multiple displays」不影响用
- 截图坐标换算：`实际 = 截图 × (设备分辨率 / 截图分辨率)`

## 九、什么时候该放弃 WebView 换原生

不是「崩了几次」，而是：

- 崩溃源在**你的代码**（某个组件的用法）→ 换掉它，继续 WebView
- 崩溃源在 **Chromium 库层**（`libmonochrome`、系统 WebView 版本）→ 换掉它意义不大，
  系统升级还会崩，这时换原生才划算
- 需要的能力 WebView 给不了（后台任务、推送、系统分享）→ 换原生

换原生时，**WebView 那一层里真正值钱的东西可以带走**：SRS 公式、
数据模型、导入/备份协议、以及那几套测试。换掉的是 UI 层。