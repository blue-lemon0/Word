# 极简单词 —— 背单词

一个本地优先的背单词应用：**Vue 3 + IndexedDB 的网页应用**，套 Android WebView 壳打包成
APK 离线使用。内容靠 **AI 生成 + 手动添加**，进度只存在本机，备份靠自己导出。

> 应用名「极简单词」，包名 `com.wordbank.*`。当前版本 **0.3.2**，见
> [GitHub Releases](https://github.com/blue-lemon0/Word/releases)。

## 功能一览

- **学**：首页「复习 / 学习」两组整轮训练、随便刷、拼写练习、扫读（看句猜词）；
  每组题量可选 10 / 20，切换即时生效
- **义项计数**：复习 / 学习按**义项**计数，训练页实时显示「剩 N 义项 / M 词」；
  词库页以**词**为主，义项数只作为括号里的补充
- **记**：SRS 间隔重复（参数化配置，有黄金向量基准）、错题板、例句标记
- **不学**：整个单词或单个义项都可以设为「不学」——退出复习和统计，但仍可搜索、
  查词；随时恢复，学习记录不清空
- **已掌握**：可撤销；取消掌握只重新排期，不丢 S/D/reps
- **听**：Edge TTS 免 key 神经音色（在线合成 + 本地缓存，听过的句子离线重播）；
  自动播放开关（出题读词、答完读句）；合成失败静默，手动点喇叭才回落系统 TTS
- **内容**：导入内容包 `cards.json`；AI 助手可选（默认关闭）——查词、补例句、
  整库体检；单句义项批量补句
- **数据**：word.backup v2 导出 / 恢复，自动快照回滚；换机先导出
- **更新**：更多页可检查 GitHub Release；APK 从发布页下载安装

## 快速开始

```bash
cd app/web
npm install
npm run dev               # -> http://127.0.0.1:5180/
npm run apk               # 构建 + 自检 + 装到真机（需 adb + JDK）
npm run apk:release       # 签名 APK + AAB（需配置 keystore，见 docs/RELEASE-SIGNING.md）
```

首次打开会问怎么开始：**用示例词体验 / 导入自己的词库 / 先空着**。示例是
`public/seed.json` 里的 3 个词、7 个义项、14 句例句；用完可在「更多 → 示例词库」
一键清掉没学过的部分。

正式词库在应用内「词库 → 导入」选 `build/bundle/cards.json`（7884 卡）。它是
本机历史产物，**不入库**；仓库只带示例种子。

## 下载与更新

- 正式包在 [GitHub Releases](https://github.com/blue-lemon0/Word/releases) 发布，
  文件名 `app-release.apk`，已用项目 release 证书签名。
- 「更多 → 检查更新」只查最新正式版，不自动下载/安装。
- debug 包名是 `com.wordbank.app.debug`，不能覆盖安装正式包；两者数据各自独立。

## 仓库结构

```
build/bundle/cards.json      内容包 word-bundle v1 —— 本机历史产物（gitignore），app 只读
     │
     ▼
app/                         背单词应用：出题、SRS、落库；唯一 UI 与运行时
     │  备份 / 换机（格式受 CONTRACT.md 约束）
     ▼
word.backup v2               学习进度与内容备份包
```

| 路径 | 是什么 |
|---|---|
| `app/web/` | 前端（Vue 3 + Dexie/IndexedDB），唯一 UI |
| `app/android/` | Android 壳（WebView + 原生桥：TTS / 文件 / HTTP） |
| `app/srs.mjs` + `app/tests/verify_srs.py` | SRS 参照实现与参数基准 |
| `scripts/verify_docs.py` | 结构守卫：文件布局、文档计数、交互契约机械检查 |
| `docs/` | 设计文档与决策记录（D32+） |
| [CONTRACT.md](CONTRACT.md) | 内容包 v1 格式约定 |
| [MANIFEST.md](MANIFEST.md) | 全仓文件台账、已知缺口 |
| [LICENSE](LICENSE) | 代码许可证：LGPL-3.0-only |
| [CONTENT-LICENSE.md](CONTENT-LICENSE.md) | 示例内容与用户导入内容的授权边界 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方组件与 Edge TTS 移植说明 |

## 技术栈与架构

**前端（唯一 UI 与运行时）**

- Vue 3 + Vite + TypeScript，Vant 组件库；Dexie 封 IndexedDB 做本地存储
- 无后端依赖：内容包（JSON）导入后全部离线，进度库与内容包一一隔离
- 自研翻页封装 `useSnapPager`：落定模型统一管程序化翻页与滚动恢复，
  所有页面禁止旁路 `scrollBy/scrollTo`（有机械守卫检查）

**Android 壳（WebView + 原生桥）**

- WebView 加载打包进 assets 的前端，`@JavascriptInterface` 双向桥：
  系统 TTS / 文件读写 / 剪贴板 / HTTP（含二进制 Base64 回传）
- release 开 R8，`proguard-rules.pro` 显式保留桥方法

**语音（Edge TTS 免 key）**

- 原生层 OkHttp WebSocket 直连微软「大声朗读」通道；v2 DRM 签名
  （CS64 + 变形 SHA-256）移植自 edge-tts 7.3.1，黄金向量对拍验证
- 前端调度：在线合成 + IndexedDB 音频缓存（同句重播零延迟零花费）；
  「能等就等」、连续失败 3 次熔断；自动播放失败静默，
  系统 TTS 只在手动点喇叭时兜底

**SRS 间隔重复**

- 公式与参数分离：参数唯一真相源是 TSV，JS/Python 双实现黄金向量对拍

**AI 助手（可选，默认关闭）**

- 配置只存本机不进备份；提议-预览-确认三段式落库；
  AI 代码集中在 `src/ai/`，有守卫断言不越界

**质量保障**

- `verify_docs.py` 机械守卫：文件布局、交互契约（如翻页禁令）
- SRS 数值对齐 + flow smoke 行为断言 + vue-tsc，全绿才许提交

## 回归（改动后从仓库根执行）

```bash
python scripts/verify_docs.py                   # 结构与契约自洽守卫
node app/web/tests/srs_parity.mjs               # SRS 移植一致性
node app/web/tests/flow_smoke.mjs               # 数据层端到端
cd app/web && npx vue-tsc --noEmit              # 前端类型检查
python app/tests/verify_srs.py                  # SRS 参数基准
```

## 开源许可

- **代码**：**LGPL-3.0-only**。Android 端的 Edge TTS 实现移植自
  [edge-tts](https://github.com/rany2/edge-tts)（LGPL-3.0），因此项目整体按
  LGPL-3.0 发布；完整许可证见 [LICENSE](LICENSE)，LGPL 引用的 GPL-3.0 文本见
  [COPYING.GPL-3.0](COPYING.GPL-3.0)。
- **示例内容**（`public/seed.json`、README/文档）：CC0-1.0，可自由使用；
  见 [CONTENT-LICENSE.md](CONTENT-LICENSE.md)。
- **用户导入的内容包 / AI 生成内容**：不属于本项目授权范围，权利与合规由导入者负责。
- **第三方组件**：Vue / Vant / Dexie / OkHttp / AndroidX 等按各自许可证使用，
  详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `LICENSES/`。

## 说明

- 签名密钥（`*.jks` / `keystore.properties`）只在本机，绝不入库；模板见
  `app/android/keystore.properties.example`。
- 这是一个自用取向的应用：无账号、无服务端、无云端同步；数据丢失只能靠你自己
  的备份。
