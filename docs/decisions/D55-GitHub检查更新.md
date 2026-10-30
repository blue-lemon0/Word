# D55 —— 检查更新只查 GitHub Release，不接管安装

> 决策日期：2026-10-30
> 一句话：**「更多」页版本行手动查 GitHub 最新正式版；有新版本开 Release 页，让系统浏览器下载安装。**

---

## 一、为什么不做全自动更新

| 方案 | 代价 |
|---|---|
| 页面里直接下载 APK | WebView 的 `<a download>` 行为不可靠；下载完也拉不起安装器 |
| 原生下载 + 安装器 | 要加 `REQUEST_INSTALL_PACKAGES`、未知来源授权、FileProvider、下载进度；还有 OEM 安装器差异 |
| 应用商店 | 当前只发 GitHub APK（D54），没有商店渠道 |

第一版先把「知道有新版本」做对。安装仍走用户熟悉的系统流程，应用不接管。

## 二、入口为什么放在版本行

「更多」页已经很长，更新是低频动作，不新占卡片。版本行本来就是「关于」信息：

```text
v0.2.0 · 检查更新
v0.2.0 · 已是最新
v0.2.0 → v0.3.0 · 有新版本
v0.2.0 · 检查失败，重试
```

有更新时点版本行开底部 Sheet：版本、更新说明（去掉 Markdown 标记的纯文本）、包大小、
「打开发布页」。不加启动弹窗，也不在首页打断背单词。

## 三、版本号必须单源

前端 `APP_VERSION` 只从 `app/web/package.json` 读。发版流水线在 `npm run build` 之前
先 `npm version <version>`，再改 Android 的 `versionName`/`versionCode`。

否则会出现：Android 包已经 0.3.0，页面还写 0.2.0，检查更新永远认为自己旧。

## 四、debug 包的边界

debug APK 的包名是 `com.wordbank.app.debug`，release 是 `com.wordbank.app`，
签名也不同。GitHub 上的正式包**不能覆盖安装 debug 包**。
所以 Sheet 在 debug 包会明确写「当前是开发版，不能直接覆盖安装」，但不阻止查看。

## 五、失败策略

- GitHub API 8 秒超时；失败只把版本行变成「检查失败，重试」+ 一条 toast
- 不自动重试、不后台轮询、不阻塞启动
- 没有配置任何代理；GitHub 连不上时，功能就是不可用，不影响离线背单词

## 相关

- `app/web/src/update.ts`
- `app/web/src/pages/MorePage.vue`
- `.github/workflows/release.yml`
- [D54](./D54-只发布安卓其他平台后议.md)
