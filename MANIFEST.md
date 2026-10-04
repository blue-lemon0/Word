# MANIFEST

这个仓库是什么、每个文件是什么、怎么跑起来、去哪改什么。
**先读这一页，再读代码。**

## 一句话

背单词 Web 原型。用户设计只有一份（`tools/index.html`），后端 `app/` 读写本地
SQLite，内容与学习进度分开存放。词表来自 ECDICT，例句为项目自建。

## 跑起来

```bash
pip install cmudict                    # 仅 build_ipa.py 需要
node app/server.mjs                    # -> http://127.0.0.1:8777
```

打开 <http://127.0.0.1:8777/tools/index.html>（`/` 同）。
8000 端口上的 `python -m http.server` **没有** SQLite/SRS 接口，别用那个。

## 三层结构：source → data → build

依赖**只向下**。`build/` 任何时候可以整个删掉重建。

```
source/     外部快照，不可再生 —— 全仓库唯一必须备份的东西
  ecdict_snapshot.json            ECDICT CSV 的唯一快照（CSV 在仓库外）

data/       真相源 —— 人可读、人可改、人可审，全部入库
  spec.yaml                      内容规格：句长区间/每义项句数/生僻词黑名单
  wordlist/senses/<word>.tsv      义项（2998 词）  senseId pos glossZh tier trap
  wordlist/kaoyan_dagang_core.tsv 考研大纲 3000 词（pos tier freq gloss 分类）
  wordlist/ipa.tsv                CMUdict 音标，按词性
  sentences/<word>.tsv            例句（52 词）    senseId text clue span translation note
  profile/srs_params.tsv          SRS 参数（唯一真相源）

build/      派生产物 —— 一条命令重建，永不入库
  bundle/cards.json              1.2 MB，运行时唯一输入
  intermediate/                   ECDICT 切分中间产物，无脚本依赖它

content/    创作过程产物（提示词模板），与 data/ 分离
archive/    历史物：不可运行的 ETL、被取代的旧词表、旧格式说明文档
```

### 归属规则（都能机械检查）

1. **一个事实只存一处。** 义义只存 `data/wordlist/senses/`。曾经义项同时存在于
   散 TSV 和 `ecdict_senses_b.json`，`build_bundle` 读前者、`pick_words` 读后者 ——
   已统一到 `data/`。
2. **派生只向下。** `scripts/` 不读 `build/`。`build/` 不含任何手写内容。
3. **真相源全是人类可读文本。** TSV / YAML，没有大 JSON。
4. **派生产物全部 gitignore。**
5. **`data/spec.yaml` 是内容规格**，`sentence_audit.py` 从它加载（当前仍从代码常量
   加载，由 `scripts/make_spec.py` 同步 —— 见「已知缺口」）。

## 代码分工

| 位置 | 职责 | 依赖 |
|---|---|---|
| `tools/index.html` | **唯一 UI**，用户原设计，只做增量改动 | 读 `build/bundle/` |
| `app/server.mjs` | HTTP 服务 + API | 读 `build/`、读写 `data/user.db` |
| `app/db.mjs` | 投影、队列、幂等落库、历史、标记 | SQLite |
| `app/srs.mjs` | SRS 引擎 | 读 `data/profile/` |
| `app/schema.sql` | 表结构 | — |
| `scripts/build_senses.py` → `select_tier_b.py` → `emit_senses_b.py` | `source/` → `data/wordlist/senses/`，**已跑过，链路保留** | 需中间产物 |
| `scripts/build_ipa.py` | 生成音标 | 需 `cmudict` |
| `scripts/build_bundle.py` | `data/` → `build/bundle/`，纯烘焙零判断 | `data/` |
| `scripts/sentence_audit.py` | 句子质检 G1–G7 + SPAN/SID/NOTE/GLOSS | 只读 |
| `scripts/pick_words.py` | 排出下一批该做哪些词 | 只读 `data/` |
| `scripts/triage_flags.py` | 导出用户标记的问题句 | 读 `data/user.db` |
| `scripts/verify_*.py`、`e2e_*` | 测试 | — |

## 常用命令

```bash
python scripts/pick_words.py --n 30 --target 300   # 下一批做哪些词
python scripts/sentence_audit.py                  # 质检全部例句
python scripts/sentence_audit.py --fix-spans      # 重算 span 偏移
python scripts/build_bundle.py                    # 重建 bundle
python scripts/triage_flags.py                    # 导出被标记的问题句

node scripts/e2e_d16.js        # 原型与 bundle 回归
node scripts/e2e_loop.mjs      # SRS、事务、幂等、持久化
python scripts/verify_srs.py
python scripts/verify_docs.py
python scripts/smoke_http.py   # 需先启动 server
```

e2e 需要 jsdom：
`$env:NODE_PATH="C:\Users\huaiqi\AppData\Local\Temp\opencode\node_modules"`

## 当前进度

| | |
|---|---|
| 卡片 | 7884 义项 / 2998 词 |
| 有例句 | **186 义项 / 52 词 / 930 句** |
| 目标 | 300 词（约 5570 句，约 19 轮） |
| 音标 | 2998 词全覆盖 |

完整 7884 义项 = 39420 句，约 140 轮。**做不完，也不该做** —— 20 题一轮，
45 轮内容摊到几个月正是一个完整训练量。

## 已知缺口

1. **53 条例句的 note 释义与词库对不上**（`sentence_audit.py` 的 GLOSS 规则）。
   其中 **36 句在教错的义项**：`terrible`（3 义项整体错位）、
   `civil`（s3 写的"内战"根本不是 ECDICT 的义项）、`injury` s2、
   `coast` s3、`grand` s1、`motor` s3。这些是内容 bug，不是检查 bug。
   另 17 条是措辞差异（`解散/散会` vs `解散`），非错误。
2. **`data/spec.yaml` 尚未被 `sentence_audit.py` 加载**，目前靠
   `scripts/make_spec.py` 同步。规格还是代码里的常量。
3. `scripts/build_senses.py` / `select_tier_b.py` 的输入输出路径已随本次迁移
   更新，但**未在本次验证可重跑**（重跑会覆写已入库的 `kaoyan_dagang_core.tsv`）。
4. `archive/tools/etl-2026-09/` 里 4 个脚本**永久不可运行**：输入是仓库外的临时
   CSV，或会就地改写不可再生的快照。保留仅为溯源。
5. `docs/decisions/` 与根目录两份 `*.md`（`单词记忆逻辑-v2.4.md`、`学习逻辑记录.md`）
   存在近重复，尚未合并。

## 决策记录

`docs/decisions/` D15（词库来源）、D16（断舍离）、D17（存储分层）。
`docs/design/` 01–05 原始设计。历史说明文档在 `archive/`。