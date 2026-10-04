# MANIFEST

这个仓库是什么、每个文件是什么、怎么跑起来、去哪改什么。
**先读 [README.md](README.md) 上手，读本页查台账；两侧交接格式读 [CONTRACT.md](CONTRACT.md)。**

## 一句话

单仓双子系统的背单词原型：`content-kit/` 生产词表与例句并烘焙成内容包，
`app/` 是唯一的背单词 UI 与运行时，读写本地 SQLite。词表来自 ECDICT，
例句为项目自建。双方不共享代码/数据库，只通过 `build/bundle/cards.json`
与（备份用的）`progress.json` 对话。

## 跑起来

```bash
node app/server.mjs                    # -> http://127.0.0.1:8777
```

打开 <http://127.0.0.1:8777/>（Node 22+，内置 node:sqlite）。
8000 端口上的纯静态服务器**没有** SQLite/SRS 接口，别用那个。

## 双子系统结构

```
content-kit/   内容产线（Python）。真相源是人可读的 TSV/YAML
  spec.yaml                      内容规格：句长区间/每义项句数/超纲词黑名单
  prompts/                       造句与评审的提示词模板
  pipeline/                      pick_words / sentence_audit / build_bundle /
                                 triage_flags / verify_ecdict
  data/wordlist/senses/          义项（2998 词 / 7884 行） senseId pos glossZh tier trap
  data/wordlist/kaoyan_dagang_core.tsv   考研大纲核心词与档位
  data/wordlist/ipa.tsv          音标，按词性
  data/sentences/                例句（52 词 / 930 句） senseId text clue span translation note source
  source/ecdict_snapshot.json    外部快照，不可再生 —— 全仓库唯一必须离线备份的东西

build/         派生产物（交接区），整个 gitignore，随时可重建
  bundle/cards.json              内容包，运行时唯一输入（word-bundle v1，见 CONTRACT.md）

app/           背单词应用（Node + 原生 JS 单页）
  server.mjs db.mjs srs.mjs      HTTP / 数据与守门 / SRS 引擎
  schema.sql                     进度库 schema 唯一真相源
  config/srs_params.tsv          SRS 参数唯一真相源
  web/index.html                 唯一 UI
  tools/progress_io.mjs          学习进度导出/导入（word-progress v1）
  tests/                         e2e_d16.js / e2e_loop.mjs / smoke_http.py / verify_srs.py
  state/user.db                  学习进度（运行时生成，不入库，要备份）

scripts/verify_docs.py           跨两侧的结构守卫
docs/                            设计文档（design/01–05）与决策记录（decisions/）
archive/                         历史物：不可运行 ETL、已完成词库管线、旧词表、旧文档
```

依赖方向：`content-kit → build/bundle ← app`，只向下。`build/` 不含手写内容。

### 归属规则（都能机械检查，scripts/verify_docs.py 守门）

1. **一个事实只存一处。** 义项只存 `content-kit/data/wordlist/senses/`，
   例句只存 `content-kit/data/sentences/`。曾经义项同时存在于散 TSV 和
   `ecdict_senses_b.json`，两个脚本各读一份 —— 已统一到 TSV；那两个中间
   JSON 已于 2026-10 双子系统拆分时删除。
2. **派生只向下。** `content-kit/pipeline/` 不读 `app/state/`
   （`triage_flags.py` 只读问题句标记，是唯一例外）；`build/` 全是产物。
3. **真相源全是人类可读文本**：TSV / YAML，没有需要手改的大 JSON。
4. **派生产物全部 gitignore**：`build/`、`app/state/`、`__pycache__/`。
5. **`content-kit/spec.yaml` 是内容规格**，`sentence_audit.py` 每次运行加载。
   （2026-10 规格反转：此前真相源是代码常量，make_spec.py 已删除。）

## 代码分工

| 位置 | 职责 |
|---|---|
| `app/web/index.html` | **唯一 UI**，只做增量改动；读 `/build/bundle/cards.json` |
| `app/server.mjs` | HTTP 服务 + API；读内容包、读写 `app/state/user.db` |
| `app/db.mjs` | 内容包守门与投影、队列、幂等落库、历史、标记 |
| `app/srs.mjs` | SRS 引擎，读 `app/config/srs_params.tsv` |
| `app/schema.sql` | 进度库表结构（含 `due_at` / `attempt_id` 不变量） |
| `app/tools/progress_io.mjs` | 学习进度包导出/导入（CONTRACT.md §2） |
| `content-kit/pipeline/build_bundle.py` | TSV → `build/bundle/`，纯烘焙零判断 |
| `content-kit/pipeline/sentence_audit.py` | 句子质检 G1–G7 + SPAN/SID/NOTE/GLOSS，规格读 spec.yaml |
| `content-kit/pipeline/pick_words.py` | 排出下一批该做哪些词 |
| `content-kit/pipeline/triage_flags.py` | 汇总应用里被标记的问题句（只读 app 库） |
| `content-kit/pipeline/verify_ecdict.py` | ECDICT 快照完整性检查 |
| `scripts/verify_docs.py` | 跨侧结构守卫：布局、数字、契约字段自洽 |
| `archive/2026-10-retire/scripts/` | 词库/音标管线 5 件**已完成归档**，重跑会覆写入库数据 |
| `archive/tools/etl-2026-09/` | 4 个**永久不可运行**的 ETL，保留仅为溯源 |

## 常用命令（均从仓库根运行）

```bash
# 内容侧
python content-kit/pipeline/pick_words.py --n 30 --target 300
python content-kit/pipeline/sentence_audit.py
python content-kit/pipeline/sentence_audit.py --fix-spans
python content-kit/pipeline/build_bundle.py
python content-kit/pipeline/triage_flags.py

# 应用侧回归
node app/tests/e2e_loop.mjs
node app/tests/e2e_d16.js          # 需 jsdom：把 jsdom 目录加入 NODE_PATH
python app/tests/verify_srs.py
python scripts/verify_docs.py
python app/tests/smoke_http.py     # 需先启动 server；会清空它打到的库，勿打日常库

# 学习进度备份/换机
node app/tools/progress_io.mjs export progress.json
node app/tools/progress_io.mjs import progress.json
```

## 当前进度

| | |
|---|---|
| 卡片 | 7884 义项 / 2998 词 |
| 有例句 | **186 义项 / 52 词 / 930 句** |
| 目标 | 300 词（约 5570 句，约 19 轮） |
| 音标 | 2998 词全覆盖 |

完整 7884 义项 = 39420 句，约 140 轮。**做不完，也不该做** —— 20 题一轮，
45 轮内容摊到几个月正是一个完整训练量。

## 已知缺口 / 历史结论

1. ~~53 条例句的 note 释义与词库对不上~~ **已修（2026-10）**。GLOSS 规则查出
   36 句在教错的义项（terrible / civil / injury / coast / grand / motor 等），
   全部重写，note 释义统一成词库 `glossZh` 原文。现在 930 句 PASS 930。
2. ~~`spec.yaml` 未被审计脚本加载~~ **已修（2026-10）**。规格反转完成，
   改规格不再碰代码，`make_spec.py` 已删除。
3. 词库管线已整体归档到 `archive/2026-10-retire/scripts/`（5 件，见该目录
   ARCHIVE.md）。重跑会覆写已入库的词表 TSV，如需重跑先移回活管线目录。
4. `archive/tools/etl-2026-09/` 里 4 个脚本**永久不可运行**：输入是仓库外临时
   CSV，或会就地改写不可再生快照。
5. ~~根目录文档与 `docs/decisions/` 近重复~~ **已修（2026-10）**。旧版全量
   台账归档到 `archive/2026-10-retire/`；现行决策只看 `docs/decisions/`。
6. `civil` 的「市民的 / 公民的」两个义项中文近乎同义，判别价值低，已加入
   `pick_words.py` 的 `UNSEPARABLE` 表以免再生成。
7. 2026-10 双子系统拆分：原 `scripts/`（内容脚本）、`data/`、`source/`、
   `prompts/` 归入 `content-kit/`；应用件归入 `app/`；内容包字段从单字母
   缩写（w/s/zh/rows/t/k/…）改为全称，并加 `format`/`schemaVersion` 守门，
   格式见 CONTRACT.md。

## 移植清单（→ Kotlin/Android）

本仓库是验证场。移植作业范围：

**要移植的本体：**

| 件 | 说明 | 对照基准 |
|---|---|---|
| `app/srs.mjs` | SRS 引擎公式 | `app/tests/verify_srs.py` + `e2e_loop.mjs` 黄金向量 |
| `app/schema.sql` | 数据模型（含 `due_at` / `attempt_id` 不变量） | `docs/design/05`、CONTRACT.md §2 |
| `app/db.mjs` | 投影、队列、幂等落库、历史、标记（逻辑移植，SQLite 可换 Room） | `docs/design/05` |
| `content-kit/data/` | 词表 / 例句 / 规格，原样带走（或经内容包 cards.json 消费） | CONTRACT.md §1 |
| `app/config/srs_params.tsv` | SRS 参数 | — |
| `docs/design/03` | 记忆曲线与复习的行为规范 | — |

**不移植：**

- `content-kit/pipeline/` —— Python 内容生产脚手架
- `content-kit/source/` —— ECDICT 一次性快照
- `build/` —— 派生产物；Android 侧直接消费内容包或等价打包资源

## 决策记录

`docs/decisions/` D15（词库来源）、D16（断舍离）、D17（存储分层）。
`docs/design/` 01–05 原始设计。历史说明文档在 `archive/`。
