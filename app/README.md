# app — 背单词应用

> **UI 已经搬到浏览器端**：当前应用是 [`app/web/`](web/README.md)（Vue 3 + Dexie/
> IndexedDB，离线可用）。本目录剩下的东西是它的**基础设施**：
> 内容包交接、SRS 参照实现、进度与标记工具，以及旧服务端骨架。
> 下面的「运行」一节讲的是旧服务端那一线。

消费内容包 `build/bundle/cards.json`，出题、按 SRS 排期、把学习进度落到本地
SQLite。单进程 Node 服务 + 一个原生 JS 单页，无构建步骤。

## 运行

```bash
node app/server.mjs          # Node 22+（内置 node:sqlite）
```

打开 <http://127.0.0.1:8777/>。

启动时做两件事：读内容包并在库里建立轻量投影（仅 tier/陷阱标记/句数，
**内容本身不入库**）；随后所有出题都在 SQL 层完成。内容包 `format` 或
`schemaVersion` 不符会直接拒绝启动（守门在 `db.mjs`，规则见根目录
[CONTRACT.md §1](../CONTRACT.md)）。

## 多内容源（验证包）

交接区可有多个内容包，环境变量**成对**切换（内容包 + 进度库一起换）：

```bash
# 验证 WordNet 重切包（docs/INTEGRATE-V2.md），与主服务并存互不干扰：
PORT=8778 WORD_BUNDLE=build/bundle/cards_v2.json WORD_DB=app/state/user_v2.db node app/server.mjs
```

- 默认不带环境变量 = 线上 `cards.json` + `state/user.db`，行为与从前完全一致。
- v2 的义项按 WordNet synset 重切，`senseId` 编号与主包指**不同义项**，
  进度锚点 `(word, senseId)` 互不继承（CONTRACT.md §1.7）——所以必须配
  独立 `WORD_DB`，验证库（`state/user_v2.db`）是一次性产物，验证完可删。
- 「词库」tab 平铺全部义项（词性/中文释义/英文释义/句数），无句义项
  明确标「暂无例句」；英文释义只出现在答题后与词库页，出题时不露出。
- 前端内容源跟随 `/api/bootstrap` 的 `bundleUrl`，localStorage 存档按内容包
  版本隔离，两包切换不串档。
  （以上是多内容源机制在旧单页那一线的现状；浏览器端的应用直接选内容包文件，
  不经过这层 HTTP。）

## 文件分工

| 文件 | 职责 |
|---|---|
| `web/` | **当前应用**：Vue 3 + Dexie，界面、数据层、备份全在这里，见 [web/README.md](web/README.md) |
| `server.mjs` | 旧服务端骨架：HTTP 与 API；静态托管交接区。**不再提供 UI** |
| `db.mjs` | 内容包加载与守门、投影重建、队列、幂等落库、历史、标记 |
| `srs.mjs` | SRS 引擎（稳定度 S / 难度 D / 排期），参数全部外置；浏览器版移植的参照对象 |
| `schema.sql` | 旧进度库 schema 真相源（Node 与未来 Android 共用同一份 SQL） |
| `config/srs_params.tsv` | SRS 参数唯一真相源，改参数不动代码（`web/src/srs_params.json` 由它生成） |
| `state/user.db` | 旧进度库（运行时生成，**不入库、要备份**） |
| `tools/progress_io.mjs` | 旧进度库的学习进度导入导出（见下） |
| `tools/flags.mjs` | 问题句标记关单：标记修复发布后清理 `sentence_flag`（见下） |
| `tests/` | 旧服务端回归测试；浏览器端的测试在 `web/tests/` |

存储分层（详见 `docs/decisions/D17`）：内容包一次性读内存；`card` 表只是
投影，内容包升级即整表重建；`card_state` 是用户进度唯一真相；`review_log`
只增不改，所有统计从它重算。

## 备份与换机

```bash
## 备份与换机

当前应用（浏览器端）备份在自己的库里：「更多 → 导出（含进度）」产出
`wordbank_YYYYMMDD_HHMM.vwbak`，格式 `word.backup` v2，见
[web/README.md](web/README.md)。下面是**旧服务端**那一线的进度包：

```bash
# 导出 app/state/user.db -> progress.json（格式 word-progress v1）
node app/tools/progress_io.mjs export progress.json

# 在另一台机器（或空库）导入；流水按 attemptId 幂等，重复导入不产生重复记录
node app/tools/progress_io.mjs import progress.json
#   --force  连前端 UI 状态也覆盖；默认只在本地无 UI 状态时恢复
#   --db PATH  指定别的库文件（测试用）
```

字段、时间戳约定、悬空锚点（内容包版本不一致）的处理规则见
[CONTRACT.md §2](../CONTRACT.md)。**直接拷贝 `state/user.db` 也是完整备份**，
进度包是给人读、给未来 Android 端解析的可迁移格式。
**`word-progress` v1 与浏览器端的 `word.backup` v2 不通用**：锚点体系不同
（`word#senseId` vs 义项内部 UUID），别把旧进度包导进新应用。

## 问题句纠错闭环

背诵时点「这句有问题」+ 备注 → 写入 `sentence_flag`，该句**当场退出出题池**
（队列实时读表，无需重启）。修复与关单：

```bash
# 生成侧拿待修清单（content-kit 只读本库）：
python content-kit/pipeline/triage_flags.py --json
# 生成侧改 content-kit/data/sentences/*.tsv → 审计 → 发布重启后：
node app/tools/flags.mjs list           # 每条标记标 [待修] / [已修?]
node app/tools/flags.mjs purge-stale    # 句子原文已随发布消失的，批量关单
# 只改译文、原文没变的修复，标记仍精确命中，确认后手动关单：
node app/tools/flags.mjs resolve fellow s3 "The two young"
```

判定依据是当前内容包：句子原文不在了 = 疑似已修（STALE）；句子还在 = 待修（OPEN）。
工具用短事务 + busy_timeout，**服务运行时也能执行**；`--db PATH` 可指定别的库。

## 测试

浏览器端应用（当前 UI，日常改的是这条）：

```bash
node app/web/tests/srs_parity.mjs   # 浏览器版 SRS 与 app/srs.mjs 逐格比对
node app/web/tests/flow_smoke.mjs    # 数据层端到端（fake-indexeddb + esbuild）
```

旧服务端那一线：

```bash
node app/tests/e2e_loop.mjs     # SRS 数值、事务、幂等、持久化（纯 Node）
python app/tests/verify_srs.py  # SRS 参数推演基准
node app/tests/e2e_d16.js       # 旧单页 UI 端到端（jsdom；那份 UI 已退场）
python app/tests/smoke_http.py  # HTTP 冒烟，需先启动 server
```

- `e2e_d16.js` 需要 jsdom：运行前把 jsdom 的安装目录加入 `NODE_PATH`。
  它测的是已被 Vue 应用取代的那份单页 UI，只作历史参考。
- **`smoke_http.py` 会重建它打到的库、清空进度**——日常有学习进度时不要
  打到主库；要跑就给服务配临时库（如 `WORD_DB=app/state/test.db`）再跑。
- 改内容侧后从仓库根跑 `python scripts/verify_docs.py`，它会同时校验
  内容包字段与本应用期望的结构。
