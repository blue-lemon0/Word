# 极简单词 —— 背单词

一个自用取向的背单词应用：**Vue 3 + IndexedDB 的网页应用**，套 Android WebView 壳打包成
APK 离线使用。内容靠 **AI 生成 + 手动添加**，进度只存在本机，备份靠自己导出。

> 应用名「极简单词」，包名 `com.wordbank.*`。

## 功能一览

- **学**：首页刷卡背词、训练页做题、拼写练习、扫读（看句猜词）
- **记**：SRS 间隔重复（参数化配置，有黄金向量基准）、错题板、复学标记
- **听**：Edge TTS 免 key 神经音色（在线合成 + 本地缓存，听过的句子离线重播）；
  自动播放开关（出题读词、答完读句）；合成失败静默，手动点喇叭才回落系统 TTS
- **内容**：导入内容包 `cards.json`；AI 助手可选（默认关闭）——查词、补例句、
  整库体检；单句义项批量补句
- **数据**：word.backup v2 导出/恢复，自动快照回滚；换机先导出

## 快速开始

```bash
cd app/web
npm install
npm run dev               # -> http://127.0.0.1:5180/
npm run apk               # 构建 + 自检 + 装到真机（需 adb + JDK）
npm run apk:release       # 签名 APK + AAB（需配置 keystore，见 docs/RELEASE-SIGNING.md）
```

首次打开自动灌 `public/seed.json`（18 词 / 66 义项）；正式词库在应用内
「词库 → 导入内容包」选 `build/bundle/cards.json`（7884 卡，本机历史产物，不入库）。

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
| [`app/web/`](app/web/README.md) | 前端（Vue 3 + Dexie/IndexedDB），唯一 UI |
| [`app/android/`](app/web/README.md#打包-android) | Android 壳（WebView + 原生桥：TTS / 文件 / HTTP） |
| [`app/`](app/README.md) | 旧服务端骨架与 SRS 参照实现（移植基准） |
| `scripts/verify_docs.py` | 结构守卫：文件布局、文档计数、交互契约机械检查 |
| [`docs/`](docs/README.md) | 设计文档与决策记录（D32+） |
| [CONTRACT.md](CONTRACT.md) | 内容包 v1 / 进度包格式约定 |
| [MANIFEST.md](MANIFEST.md) | 全仓文件台账、已知缺口、移植 Kotlin/Android 清单 |

## 技术栈与架构

**前端（唯一 UI 与运行时）**

- Vue 3 + Vite + TypeScript，Vant 组件库；Dexie 封 IndexedDB 做本地存储
- 无后端依赖：内容包（JSON）导入后全部离线，进度库与内容包一一隔离
- 自研翻页封装 `useSnapPager`：落定模型统一管程序化翻页与滚动恢复，
  所有页面禁止旁路 `scrollBy/scrollTo`（有机械守卫检查）

**Android 壳（WebView + 原生桥）**

- WebView 加载打包进 assets 的前端，`@JavascriptInterface` 双向桥：
  系统 TTS / 文件读写 / HTTP（含二进制 Base64 回传）
- release 开 R8，`proguard-rules.pro` 显式保留桥方法

**语音（Edge TTS 免 key）**

- 原生层 OkHttp WebSocket 直连微软「大声朗读」通道；2026 新 v2 DRM 签名
  （CS64 + 变形 SHA-256）逐字移植自 edge-tts 7.3.1，黄金向量对拍验证
- 前端调度：在线合成 + IndexedDB 音频缓存（同句重播零延迟零花费）；
  「能等就等」、连续失败 3 次熔断；自动播放失败静默，
  系统 TTS 只在手动点喇叭时兜底

**SRS 间隔重复**

- 公式与参数分离：参数唯一真相源是 TSV，JS/Python 双实现黄金向量对拍，
  是将来移植 Kotlin 的数值基准

**AI 助手（可选，默认关闭）**

- 配置只存本机不进备份；提议-预览-确认三段式落库；
  AI 代码集中在 `src/ai/`，有守卫断言不越界

**质量保障**

- `verify_docs.py` 162 项机械守卫：文件布局、文档计数、交互契约（如翻页禁令）
- e2e 78 项 + SRS 数值对齐 + flow smoke + vue-tsc，全绿才许提交

## 回归（改动后从仓库根执行）

```bash
python scripts/verify_docs.py                   # 结构与契约自洽守卫（162 项交互断言）
node app/tests/e2e_loop.mjs                     # SRS / 事务 / 幂等 / 持久化（78 项）
node app/web/tests/srs_parity.mjs               # SRS 移植一致性
node app/web/tests/flow_smoke.mjs               # 数据层端到端
cd app/web && npx vue-tsc --noEmit              # 前端类型检查
python app/tests/verify_srs.py                  # SRS 参数基准
```

`app/tests/smoke_http.py` 会清空被测库，不要对日常使用的 `app/state/user.db` 跑。

## 说明

- 原内容产线 `content-kit/` 与历史归档 `archive/` 已于 2026-10-20 整体删除 ——
  git 历史（`bfda5d7` 之前的任意提交）就是归档。
- 签名密钥（`*.jks` / `keystore.properties`）只在本机，绝不入库；模板见
  `app/android/keystore.properties.example`。
