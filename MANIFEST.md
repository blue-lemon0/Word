# MANIFEST

这个仓库是什么、每个文件是什么、怎么跑起来、去哪改什么。
**先读 [README.md](README.md) 上手，读本页查台账；两侧交接格式读 [CONTRACT.md](CONTRACT.md)。**

## 一句话

单仓双子系统：`content-kit/` 生产词表与例句并烘焙成内容包，
`app/` 是背单词应用 —— 界面在 `app/web/`（Vue 3 + IndexedDB，离线可用），
学习进度与内容编辑都在浏览器本地。双方不共享代码/数据库，
只通过 `build/bundle/cards.json` 对话。

## 跑起来

```bash
# 应用（当前 UI）
cd app/web; npm install; npm run dev     # -> http://127.0.0.1:5180/

# 旧服务端骨架（托管交接区 + 跑 tools/ 下的进度与标记工具）
node app/server.mjs                      # -> http://127.0.0.1:8777
```

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
  data/senses_v2/ sentences_v2/  WordNet 重切的验证包（义项划分与旧包不同，不可混用）
  source/ecdict_snapshot.json    外部快照，不可再生 —— 全仓库唯一必须离线备份的东西

build/         派生产物（交接区），整个 gitignore，随时可重建
  bundle/cards.json              内容包，运行时唯一输入（word-bundle v1，见 CONTRACT.md）
  bundle/cards_v2.json           WordNet 重切验证包（独立锚点体系）

app/           背单词应用
  web/                          **当前应用**：Vue 3 + Dexie（界面/数据层/备份），见 web/README.md
    src/types.ts db.ts edit.ts   数据模型与内容编辑（义项 id 是内部 UUID，永不变）
    src/srs.ts                   app/srs.mjs 的逐函数移植（数值必须一致，有测试）
    src/quiz.ts importer.ts      出题与导入对比；import.ts 吃两种 JSON
    src/backup.ts                word.backup v2 导出/恢复 + 自动快照回滚
    src/pages/                   首页 单词页 意思页 词库 训练 错题板 更多
    public/seed.json             首次启动的种子（cards_v2.json 副本）
    tests/                       srs_parity / flow_smoke / schema_upgrade / perf_probe / pwa_check / cdp / screencast_frames / overscroll_probe
    prototype-v2/3/4.html        设计原型，定稿是 v4（UI 照它做的）
    DEBUG-RUNBOOK.md             真机排查手册（崩溃/卡死/日志/CDP 的坑）
  android/                      Android 壳（WebView + assets 映射），`npm run apk` 一条命令打包安装
  server.mjs db.mjs srs.mjs      旧服务端骨架：HTTP / 内容包守门与投影 / SRS 参照实现
  schema.sql                     旧进度库 schema 真相源
  config/srs_params.tsv          SRS 参数唯一真相源（web 侧 JSON 由它生成）
  tools/progress_io.mjs          旧进度库的学习进度导出/导入（word-progress v1）
  tools/flags.mjs                问题句标记关单（list/purge-stale/resolve），闭环纠错流程
  tests/                         e2e_loop.mjs / verify_srs.py / smoke_http.py（e2e_d16.js 已随旧 UI 退场）
  state/user.db                  旧进度库（运行时生成，不入库，要备份）

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
| `app/web/src/` | **当前 UI 与数据层**：Vue 页面 + Dexie 数据模型 + 内容编辑 + 出题 + 备份 |
| `app/web/src/srs.ts` | `app/srs.mjs` 的逐函数移植；`tests/srs_parity.mjs` 逐格比对，不一致就红 |
| `app/web/src/importer.ts` | 导入差异计算（只读）+ 按逐条决策写库；默认保留本地释义 |
| `app/web/src/flags.ts` | 问题句标记：清单导出（word-flags v1）、关单、导入替换时保留标记 |
| `app/server.mjs` | 旧服务端骨架：HTTP + API，读内容包、读写 `app/state/user.db`。**不再提供 UI** |
| `app/db.mjs` | 内容包守门与投影、队列、幂等落库、历史、标记 |
| `app/srs.mjs` | SRS 引擎（参照实现），读 `app/config/srs_params.tsv` |
| `app/schema.sql` | 旧进度库表结构（含 `due_at` / `attempt_id` 不变量） |
| `app/tools/progress_io.mjs` | 旧进度库的学习进度包导出/导入（CONTRACT.md §2） |
| `app/tools/flags.mjs` | 问题句标记关单（list/purge-stale/resolve），闭环纠错流程 |
| `content-kit/pipeline/build_bundle.py` | TSV → `build/bundle/`，纯烘焙零判断 |
| `content-kit/pipeline/sentence_audit.py` | 句子质检 G1–G7 + SPAN/SID/NOTE/GLOSS，规格读 spec.yaml |
| `content-kit/pipeline/pick_words.py` | 排出下一批该做哪些词 |
| `content-kit/pipeline/triage_flags.py` | 汇总应用里被标记的问题句（只读 app 库；浏览器端的标记在 IndexedDB 里，此脚本暂只覆盖旧服务端那一线） |
| `content-kit/pipeline/verify_ecdict.py` | ECDICT 快照完整性检查 |
| `scripts/verify_docs.py` | 跨侧结构守卫：布局、数字、契约字段、前端四条设计判断 |
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

# 应用侧（浏览器端）
node app/web/tests/srs_parity.mjs    # SRS 移植一致性
node app/web/tests/flow_smoke.mjs    # 数据层端到端

# 应用侧（旧服务端那一线）
node app/tests/e2e_loop.mjs
node app/tests/e2e_d16.js            # 旧单页 UI，已退场，仅参考
python app/tests/verify_srs.py
python app/tests/smoke_http.py       # 需先启动 server；会清空它打到的库，勿打日常库
python scripts/verify_docs.py        # 跨侧结构守卫

# 旧学习进度备份/换机
node app/tools/progress_io.mjs export progress.json
node app/tools/progress_io.mjs import progress.json

# AI 体检的真机驱动（会花钱：每个词一次真实调用；缓存命中的免费）
node app/web/tests/audit_drive.mjs
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
8. **2026-10 应用搬到浏览器端**：`app/web/` 从单文件原型重写成 Vue 3 + Dexie
   （数据落 IndexedDB，离线可用，不再需要 Node 服务）。随之三处变了：
   学习进度锚点从 `word#senseId` 换成**义项内部 UUID**（插删改序义项不再让
   进度错位）；备份格式换成 `word.backup` v2（旧的 `word-progress` v1 不通用）；
   `app/server.mjs` 退成骨架，只剩交接区托管与工具。设计见
   [docs/DESIGN-词库系统v2.md](docs/DESIGN-词库系统v2.md)，台账见
   [app/web/README.md](app/web/README.md)。
9. **句标记闭环已打通（2026-10-17）**：浏览器端把问题句导出成 `word-flags` v1
   （错题板 → 导出清单），`triage_flags.py --from` 接这份清单，
   修好后回错题板点「已修好」关单。内容侧只读那个文件，不碰浏览器数据。
   导入替换例句时按原文保留标记，避免「只改译文」的修复让标记悄悄消失。
10. **答完能查词 + 可选 AI（2026-10-19）**：
   - 训练页答完这一题后，句子里**每个词**都能点开：浮层看义项（带例句数）、
     进义项/词条详情；不在库里的词可当场加入（建词条 + `needsRefine` 占位义项）。
     答之前不可点 —— 这道题问的就是这个词的意思（D37，查词 5 项守卫 + 13 条断言）。
   - AI 助手（D38）：可选、默认关闭、代码全在 `app/web/src/ai/`，
     只产出提案、落库由人点「应用」（应用前自动存内容快照）。
     四个动作：整词审查、**空壳词补全**（义项 + 例句一起提）、补 3 条候选例句、换掉某一句；
     协议是 OpenAI 兼容的 `/chat/completions`（DeepSeek 只是默认值），
     手机走原生 `NativeBridge.httpPost`（WebView 的 fetch 会被 CORS 拦），
     结果按「内容指纹 + 模型名」缓存 —— 内容不变不重复花钱。
     Key 存本机 localStorage、**不进备份**；填了 Key 自动开开关，入口可见性用共享的 `aiReady`。
     守卫 12 项（只在 ai/ 里、只提议不写库、幻觉绑定、缓存键含指纹、Key 不进备份、
     原生网络、入口不出现、快照、重算高亮、空壳分流、例句跟义项走、Vant 组件都注册过），
     断言在 `flow_smoke` 里用注入的假传输跑全链路。
     **真机已用真实 key 跑过三条路**：审查（1005 tokens）、换一句（975）、补全（984）。
   - 代价：Android 壳因此需要 `INTERNET` 权限（没有它只会得到
     「连不上 AI 服务」，看起来像网络问题）。
11. **AI 的三个尺度（2026-10-19 深夜）**：现场修一句（D39，训练页「有问题？改」里
   直接让 AI 换掉这句）、整词审查/补全（D38，词条页）、整库体检（D40，更多 → AI 体检）。
   体检是二级页：逐词串行、逐词确认、随时能停；**进度就是缓存**，
   跑过的词再跑 0 花费；排序是「需精修 > 缺音标 > 例句少」。
   为此提议类型扩到五种：改释义（含熟词僻义 `trap`）、补音标（`word.update`）、
   补例句（跟义项一起提）、换例句、加义项/例句。

## 移植清单（→ Kotlin/Android）

本仓库是验证场。移植作业范围：

**要移植的本体：**

| 件 | 说明 | 对照基准 |
|---|---|---|
| `app/web/src/srs.ts` | SRS 引擎公式（浏览器版，与 `app/srs.mjs` 逐格等价） | `app/web/tests/srs_parity.mjs` |
| `app/srs.mjs` | SRS 引擎公式（参照实现） | `app/tests/verify_srs.py` + `e2e_loop.mjs` 黄金向量 |
| `app/web/src/types.ts` `db.ts` | 内容/状态/历史三层 + **义项 UUID 锚点** | [app/web/README.md](app/web/README.md) |
| `app/web/src/importer.ts` | 导入差异与逐条决策 | docs/DESIGN-词库系统v2 §3.2 |
| `app/schema.sql` | 旧数据模型（含 `due_at` / `attempt_id` 不变量） | `docs/design/05`、CONTRACT.md §2 |
| `app/db.mjs` | 投影、队列、幂等落库、历史、标记（逻辑移植，SQLite 可换 Room） | `docs/design/05` |
| `content-kit/data/` | 词表 / 例句 / 规格，原样带走（或经内容包 cards.json 消费） | CONTRACT.md §1 |
| `app/config/srs_params.tsv` | SRS 参数 | — |
| `docs/design/03` | 记忆曲线与复习的行为规范 | — |

**不移植：**

- `content-kit/pipeline/` —— Python 内容生产脚手架
- `content-kit/source/` —— ECDICT 一次性快照
- `build/` —— 派生产物；Android 侧直接消费内容包或等价打包资源
- `app/server.mjs` `app/db.mjs` `app/tools/` —— 浏览器端的旧服务端那一线，
  只有要保留服务端架构时才需要（内容包托管、句标记关单、进度包）

## 决策记录

`docs/decisions/` D15（词库来源）、D16（断舍离）、D17（存储分层）、
D32（应用搬到浏览器端：技术栈与义项 UUID 锚点）、
D33（交互保护：例句显式编辑态、确认走自己的弹层、返回语义）、
D34（固定栏与橡皮筋：要栏不动就得不要橡皮筋，窗口层位移网页管不了）、
D35（信息架构：二级页不摆底栏 + 三个记录列表合成可滑动的三面板）、
D36（训练是一个动作不是一个地方：撤出底栏 + 扫读并进训练页 +
训练时当场改内容 + 干扰项按词性挑且同词优先）、
D37（答完之后才许查词：句子里每个词可点，未入库可就地加入）、
D38（接 AI：可选插件，只产出提案、落库永远由人点；OpenAI 兼容协议、
手机走原生网络、结果按内容指纹缓存省钱）、
D39（训练页也能换句：AI 要放在「发现问题的现场」）、
D40（整库体检：逐词串行 + 逐词确认 + 随时能停，进度就是缓存）、
D41（词库按学习进度组织：今天一张卡 + 五个桶，桶能直接开练；仓库口径降为「维护」）、
D42（加一个词一步到「能背」：配了 AI 就生成义项与例句，已在库就给「去这个词」）、
D43（训练页的返回栈：同一页内部的切换用 replace；扫读点一行先给答案再问练不练）、
D44（首页 = 随手背一句：卡上直接「点一下看意思」，删掉搜索框与重复的训练入口）、
D46（练习是浮层不是房间：练一句不跳页；首页内部可横滑）、
D47（练习就是首页的一个副页：快捷卡就地开练，不跳 /train）。

真机踩坑与判据在 [`docs/notes/踩坑记录.md`](docs/notes/踩坑记录.md)（61 条），
其中可机械判定的一部分挂在 `scripts/verify_docs.py` 的「真机交互守卫」里
（132 项）：这些坑都不报错，只能靠断言拦住。

守卫的**边界**要说清楚：它判的是源码文本的形状，不是行为。
所以「某功能有没有生效」只能靠断言结果的测试（本项目已有 179 条，
在 `app/web/tests/flow_smoke.mjs`）或真机量测：
「屏幕上有没有闪」用 CDP `Page.startScreencast` 逐帧抓（坑 42），
「栏到底动不动」用 `tests/overscroll_probe.mjs`（坑 45 / D34），
「某功能接上了没有」用 flow_smoke 里的行为断言（坑 52）。
