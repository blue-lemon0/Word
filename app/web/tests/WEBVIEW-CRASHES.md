# WebView 里的禁用组件（实测崩溃）

**这份表不是猜的，每一条都是在真机上触发过渲染进程崩溃才记下来的。**

## 怎么发现的

崩溃长这样，用户看到的是「卡死」：

```
[FATAL:crashpad_client_linux.cc:744] Render process (12342)'s crash
       wasn't handled by all associated webviews, triggering application crash.
```

**它不是 JS 报错，也不是布局错位**——渲染进程死了，crashpad 按 Chromium 的
规则把整个 app 带走，屏幕上就留着最后一帧，于是「所有按钮都没用」。
不查 `adb logcat -b crash` 根本看不出发生过什么。

## 已确认会崩的

| 组件 | 用在哪 | 表现 | 换成 |
|---|---|---|---|
| `van-dropdown-menu` / `van-dropdown-item` | 意思页选词性与分级 | 一进意思页就崩，屏幕停在上一帧 | 两个 `van-button` + `Sheet` 弹层（`SensePage.vue` 的 `showPos` / `showTier`） |

## 加新组件时的规矩

1. **先在真机上点一遍**。桌面上跑得好好的不算数，Node 里跑得更不算数。
2. 崩溃就记进这张表，并写下「换成什么」。
3. 怀疑某个 Vant 组件时，先怀疑它是不是用了**浮层 + 滚动监听 + 大量 JS 测量**——
   这类组件在 WebView 里的崩溃风险最高。

## 自查命令

```bash
adb logcat -b crash -c            # 清空崩溃缓冲
# ……在手机上操作一遍……
adb logcat -b crash -d | tail     # 有输出就是崩了
adb shell pidof com.wordbank.app.debug   # 空 = 进程没了（= 崩了）
```