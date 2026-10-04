# MANIFEST

这个仓库是什么、每个文件是什么、怎么跑起来、去哪改什么。
**先读这一页，再读代码。**

## 一句话

背单词 Web 原型。用户设计只有一份（`tools/index.html`），后端 `app/` 读写本地
SQLite，内容与学习进度分开存放。词表来自 ECDICT，例句为项目自建。

## 跑起来

```bash
pip install pyyaml                     # 仅 sentence_audit.py 需要
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
archive/    历史物：不可运行的 ETL、已完成的词库管线（2026-10-retire/）、
            被取代的旧词表、旧格式说明文档、退役的根目录文档
```

### 归属规则（都能机械检查）

1. **一个事实只存一处。** 义义只存 `data/wordlist/senses/`。曾经义项同时存在于
   散 TSV 和 `ecdict_senses_b.json`，`build_bundle` 读前者、`pick_words` 读后者 ——
   已统一到 `data/`。
2. **派生只向下。** `scripts/` 不读 `build/`。`build/` 不含任何手写内容。
3. **真相源全是人类可读文本。** TSV / YAML，没有大 JSON。
4. **派生产物全部 gitignore。**
5. **`data/spec.yaml` 是内容规格**，`sentence_audit.py` 每次运行从它加载。
   （2026-10 规格反转：此前真相源是代码常量，make_spec.py 已删除。）

## 代码分工

| 位置 | 职责 | 依赖 |
|---|---|---|
| `tools/index.html` | **唯一 UI**，用户原设计，只做增量改动 | 读 `build/bundle/` |
| `app/server.mjs` | HTTP 服务 + API | 读 `build/`、读写 `data/user.db` |
| `app/db.mjs` | 投影、队列、幂等落库、历史、标记 | SQLite |
| `app/srs.mjs` | SRS 引擎 | 读 `data/profile/` |
| `app/schema.sql` | 表结构 | — |
| `archive/2026-10-retire/scripts/` | 词库/音标管线 5 件**已完成归档**（build_senses → select_tier_b → emit_senses_b、build_ipa、fix_gloss_2026-10），重跑会覆写入库数据 | 见该目录 ARCHIVE.md |
| `scripts/build_bundle.py` | `data/` → `build/bundle/`，纯烘焙零判断 | `data/` |
| `scripts/sentence_audit.py` | 句子质检 G1–G7 + SPAN/SID/NOTE/GLOSS，规格读 `data/spec.yaml` | 只读 `data/` |
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

1. ~~53 条例句的 note 释义与词库对不上~~ **已修（2026-10）**。GLOSS 规则查出
   36 句在教错的义项：`terrible`（3 义项整体错位，`可怕的` 那个义项原本
   根本没有内容）、`civil`（s2 装的是 s3 的内容，s3 装的是**根本不在字典里的
   「内战」**，s1 是「公民的/公务员的」而非「市民的」）、`injury` s2
   （label 标成了 s1 的「伤害」）、`coast` s3、`grand` s1、`motor` s3。
   全部重写内容并把 note 的释义字段统一成词库 `glossZh` 原文。
   现在 930 句 PASS 930 / REJECT 0。
2. ~~`data/spec.yaml` 尚未被 `sentence_audit.py` 加载~~ **已修（2026-10）**。
   规格反转完成：spec.yaml 是唯一真相源，`sentence_audit.py` 每次运行加载它，
   改规格不再需要碰代码，`make_spec.py` 已删除。反转后 930 句质检结果与此前一致。
3. 词库管线已整体归档到 `archive/2026-10-retire/scripts/`（5 件，见该目录
   ARCHIVE.md）。重跑会覆写已入库的 `kaoyan_dagang_core.tsv` 与 `senses/*.tsv`，
   如需重跑先移回 `scripts/`。
4. `archive/tools/etl-2026-09/` 里 4 个脚本**永久不可运行**：输入是仓库外的临时
   CSV，或会就地改写不可再生的快照。保留仅为溯源。
5. ~~根目录两份 `*.md` 与 `docs/decisions/` 近重复~~ **已修（2026-10）**。
   `设计决策记录.md`（旧版全量台账）归档到 `archive/2026-10-retire/`；
   `大模型背单词软件规格-v2.4.md` 与 archive 副本逐字节相同，直接删除。
   现行决策只看 `docs/decisions/`。
6. `civil` 的「市民的 / 公民的」两个义项在中文里近乎同义，实际难以判别。
   内容已改正确，但这个词本身判别价值低，已加入 `pick_words.py` 的
   `UNSEPARABLE` 表以免再生成。

## 移植清单（→ Kotlin/Android）

本仓库是验证场。移植时的作业范围：

**要移植的本体：**

| 件 | 说明 | 对照基准 |
|---|---|---|
| `app/srs.mjs` | SRS 引擎公式 | `scripts/verify_srs.py`（Python 参考实现）+ `e2e_loop.mjs` 黄金向量逐个比对 |
| `app/schema.sql` | 数据模型（含 `due_at` / `attempt_id` 不变量） | `docs/design/05` |
| `app/db.mjs` | 投影、队列、幂等落库、历史、标记（逻辑移植，SQLite 可换 Room） | `docs/design/05` |
| `data/` 全部 | 词表 / 例句 / 规格 / SRS 参数，原样带走 | — |
| `docs/design/03` | 记忆曲线与复习的行为规范 | — |

**不移植：**

- `scripts/` —— Python 工具链，内容生产期的脚手架
- `source/` —— ECDICT 快照，生成 `data/` 的一次性输入
- `build/` —— 派生产物，Kotlin 侧直接消费 `data/`（或其等价资源）

## 决策记录

`docs/decisions/` D15（词库来源）、D16（断舍离）、D17（存储分层）。
`docs/design/` 01–05 原始设计。历史说明文档在 `archive/`。