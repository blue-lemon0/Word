# Word — 背单词（内容产线 + 应用，单仓双子系统）

本仓库把**内容生成**与**背单词应用**拆成两个互不共享代码、互不共享数据库的子系统，
双方只通过交接区里约定格式的文件对话。契约是协作的唯一语言：

- **[CONTRACT.md](CONTRACT.md)** — 两种交接文件的完整格式约定
  （内容包 `cards.json` v1 / 学习进度包 `progress.json` v1）。
- **[MANIFEST.md](MANIFEST.md)** — 全仓文件台账、历史缺口、移植 Android 的清单。

```
content-kit/                 内容产线：选词、义项、例句 → 烘焙成内容包
     │  唯一出口（机器产物，gitignore）
     ▼
build/bundle/cards.json      内容包 word-bundle v1 —— 交接区，app 只读
     │
     ▼
app/                         背单词应用：出题、SRS、落库；唯一 UI 与运行时
     │  备份 / 换机（工具，格式同样受 CONTRACT.md 约束）
     ▼
progress.json                学习进度包 word-progress v1
```

## 快速开始

```bash
node app/server.mjs          # 需要 Node 22+（用到内置 node:sqlite）
```

打开 <http://127.0.0.1:8777/> 即可背单词。应用首次启动时读 `build/bundle/cards.json`
建立索引投影；学习数据写在 `app/state/user.db`（不入库）。

> 8000 端口上的纯静态服务器没有 SQLite/SRS 接口，不是这个应用。

## 目录导航

| 路径 | 是什么 | 说明文档 |
|---|---|---|
| [`content-kit/`](content-kit/README.md) | 内容产线（Python）：词库、例句、质检、烘焙 | content-kit/README.md |
| [`app/`](app/README.md) | 背单词应用（Node + 原生 JS 单页） | app/README.md |
| `build/bundle/` | 交接区：内容包成品，可随时重建，不入库 | CONTRACT.md §1 |
| `scripts/verify_docs.py` | 跨两侧的结构守卫：文件布局与内容包自洽性 | — |
| `docs/` | 设计文档与决策记录（D15–D17 等） | — |
| `archive/` | 已退役的 ETL、旧词表、旧文档，只留溯源 | MANIFEST.md |

## 内容从哪来 / 现在有多少

词表来自 ECDICT 快照，例句为项目自建（人 + LLM 按 `content-kit/prompts/`
模板生产，经 G1–G7 质检）。当前规模：

- 词表 **2998 词 / 7884 义项**，音标全覆盖；
- 其中 **52 词 / 186 义项 / 930 句**已配例句（即可练池），其余义项可看释义、不出题；
- 内容按批递增，`content-kit` 一次只做一批词，目标 300 词。

## 回归（改动后从仓库根执行）

```bash
python content-kit/pipeline/sentence_audit.py   # 例句质检（当前 930 PASS）
python content-kit/pipeline/build_bundle.py     # 重建内容包
python scripts/verify_docs.py                   # 结构与契约自洽守卫
node app/tests/e2e_loop.mjs                     # SRS / 事务 / 幂等 / 持久化
node app/tests/e2e_d16.js                       # UI 与内容包端到端（需 jsdom）
python app/tests/verify_srs.py                  # SRS 参数基准
```

`e2e_d16.js` 依赖 jsdom：把 jsdom 安装位置加入 `NODE_PATH` 后运行。
`app/tests/smoke_http.py` 会清空被测库，不要对日常使用的 `app/state/user.db` 跑。
