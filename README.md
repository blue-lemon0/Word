# 极简单词（Jíjiǎn Dāncí）—— 背单词

> 应用名从「词库」正式改为**极简单词**。包名仍是 `com.wordbank.*`（改包名会丢本地进度，不值当）。

**应用优先**：背单词应用在 `app/web/`（Vue 3 + IndexedDB，离线可用，Android 壳打包 APK）。
内容靠 **AI 生成 + 手动添加**（AI 助手可选、默认关闭）。原内容产线
`content-kit/` 与历史归档 `archive/` 已于 2026-10-20 整体删除 ——
git 历史（`bfda5d7` 之前的任意提交）就是归档，`git checkout bfda5d7 -- content-kit archive` 可整体恢复。

- **[CONTRACT.md](CONTRACT.md)** — 内容包 `cards.json` v1 / 进度包格式约定
- **[MANIFEST.md](MANIFEST.md)** — 全仓文件台账、历史缺口、移植 Android 的清单

```
build/bundle/cards.json      内容包 word-bundle v1 —— 本机历史产物（gitignore），app 只读
     │
     ▼
app/                         背单词应用：出题、SRS、落库；唯一 UI 与运行时
     │  备份 / 换机（格式受 CONTRACT.md 约束）
     ▼
word.backup v2               学习进度与内容备份包
```

## 快速开始

```bash
cd app/web
npm install
npm run dev               # -> http://127.0.0.1:5180/
npm run apk               # 构建 + 自检 + 装到真机（需 adb + JDK）
npm run apk:release       # 签名 APK + AAB（本机需配置 keystore，见 docs/RELEASE-SIGNING.md）
```

首次打开自动灌 `public/seed.json`（18 词 / 66 义项）；正式词库在应用内
「词库 → 导入内容包」选 `build/bundle/cards.json`（7884 卡，本机历史产物）。

## 目录导航

| 路径 | 是什么 | 说明文档 |
|---|---|---|
| [`app/`](app/README.md) | 背单词应用（web + Android 壳 + 旧服务端骨架） | app/README.md |
| `build/bundle/` | 交接区：内容包成品（历史产物），不入库 | CONTRACT.md §1 |
| `scripts/verify_docs.py` | 结构守卫：文件布局与内容包自洽性 | — |
| `docs/` | 设计文档（03/05）与决策记录（D32+） | — |

## 回归（改动后从仓库根执行）

```bash
python scripts/verify_docs.py                   # 结构与契约自洽守卫
node app/tests/e2e_loop.mjs                     # SRS / 事务 / 幂等 / 持久化
node app/web/tests/srs_parity.mjs               # SRS 移植一致性
node app/web/tests/flow_smoke.mjs               # 数据层端到端
cd app/web && npx vue-tsc --noEmit              # 前端类型检查
python app/tests/verify_srs.py                  # SRS 参数基准
```

`app/tests/smoke_http.py` 会清空被测库，不要对日常使用的 `app/state/user.db` 跑。
