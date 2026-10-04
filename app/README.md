# app — 背单词应用

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

## 文件分工

| 文件 | 职责 |
|---|---|
| `server.mjs` | HTTP 服务与 API；静态托管 `web/` 与交接区 |
| `web/index.html` | **唯一 UI**（原生 JS/CSS，无框架无构建） |
| `db.mjs` | 内容包加载与守门、投影重建、队列、幂等落库、历史、标记 |
| `srs.mjs` | SRS 引擎（稳定度 S / 难度 D / 排期），参数全部外置 |
| `schema.sql` | 进度库唯一 schema 真相源（Node 与未来 Android 共用同一份 SQL） |
| `config/srs_params.tsv` | SRS 参数唯一真相源，改参数不动代码 |
| `state/user.db` | 学习进度库（运行时生成，**不入库、要备份**） |
| `tools/progress_io.mjs` | 学习进度导入导出（见下） |
| `tests/` | 回归测试 |

存储分层（详见 `docs/decisions/D17`）：内容包一次性读内存；`card` 表只是
投影，内容包升级即整表重建；`card_state` 是用户进度唯一真相；`review_log`
只增不改，所有统计从它重算。

## 备份与换机：学习进度包

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

## 测试

```bash
node app/tests/e2e_loop.mjs     # SRS 数值、事务、幂等、持久化（纯 Node）
python app/tests/verify_srs.py  # SRS 参数推演基准
node app/tests/e2e_d16.js       # UI + 内容包端到端（jsdom 内跑真实页面）
python app/tests/smoke_http.py  # HTTP 冒烟，需先启动 server
```

- `e2e_d16.js` 需要 jsdom：运行前把 jsdom 的安装目录加入 `NODE_PATH`。
- **`smoke_http.py` 会重建它打到的库、清空进度**，而服务当前固定使用
  `state/user.db`（没有库路径覆盖开关）——日常有学习进度时不要跑这个测试。
- 改内容侧后从仓库根跑 `python scripts/verify_docs.py`，它会同时校验
  内容包字段与本应用期望的结构。
