# 设计文档索引

本目录是 D15 之后的**施工文档**。与旧的 `大模型背单词软件规格-v2.4.md` 关系：
规格 v2.4 仍是产品定位与红线的来源，但本文档集**覆盖**其中已被推翻的部分。

> 规格 v2.4 的副本与旧决策台账在 `archive/2026-09-30-pre-ECDICT/specs/`。
> 根目录保留的 `大模型背单词软件规格-v2.4.md` 仍可正常阅读，两者同源。

## 阅读顺序

| # | 文档 | 作用 | 状态 |
| --- | --- | --- | --- |
| 17 | [decisions/D17-存储分层.md](decisions/D17-存储分层.md) | 内容走 bundle、进度走 SQLite；4 表落地 + 4 处修正 | **已决策并实现** |
| 16 | [decisions/D16-断舍离.md](decisions/D16-断舍离.md) | 不迁移旧数据：归档不可再生、删除可再生、从零重造 | **已决策** |
| 15 | [decisions/D15-词库源-ECDICT.md](decisions/D15-词库源-ECDICT.md) | 词库源定为 ECDICT，收敛到 7884 义项 | **已决策** |
| 01 | [design/01-句子生成与复用.md](design/01-句子生成与复用.md) | 三层句子供给、状态机、G1-G7 质检、轮换与复用 | 待施工 |
| 02 | [design/02-淘汰与替换.md](design/02-淘汰与替换.md) | 耗尽 vs 变坏、退役/替换事务边界、排布权重 | 待施工 |
| 03 | [design/03-记忆曲线与复习.md](design/03-记忆曲线与复习.md) | 替换规格 §6 的 SRS：S/D 分离、TRAP 短间隔、90 天掌握门槛 | **已实现** |
| 04 | [design/04-使用体验.md](design/04-使用体验.md) | 首页、三步答题流、错题板、明确不做的事 | **最小循环已实现** |
| 05 | [design/05-数据模型-SQLite.md](design/05-数据模型-SQLite.md) | 目标 7 表 4 视图；D17 落地为 4 表，SQL 在 `app/schema.sql` | **已实现** |

## 跑起来

```bash
python scripts/build_bundle.py    # 打包（首次或词库变动后）
node app/server.mjs               # → http://127.0.0.1:8777
```

最小学习循环已通：首页 → 三步答题 → 判对错 → 进度落 `data/user.db`。
关掉浏览器、重启服务，进度都在。

## 被本目录推翻的旧决策

| 旧出处 | 旧内容 | 新内容 | 出处 |
| --- | --- | --- | --- |
| 规格 §4.1 | 考纲词表作义项源 | ECDICT（100% 覆盖，2.63 义项/词） | D15 |
| 规格 §4.2 | 义项第 2 位起标 TRAP | 同上，但**新库 TRAP 需从零重建**（旧标记不迁移） | D15 / D16 |
| 规格 §6 | `interval`/`ease`，单位=会话数 | `stability`(天)/`difficulty`，S/D 分离 | 03 |
| 规格 §6 | 掌握 = `interval>=3` + 连对 3 | 掌握 = `S>=90天` + `reps>=6` + 连对 3 | 03 |
| 规格 §5.1 | 四约束 G1-G4 | 七约束，**新增 G5 义项唯一性** | 01 |
| 规格 §5.1 | 句长难度档 D1/D2/D3 | 保留 | 04 |
| 规格 §3 | localStorage | SQLite | 05 |
| 规格 §5.3 | REJECT 率应 > 5% | 健康区间 8-20% | 01 |
| 规格 §6 | `D + 0.35×(grade-4)` | `D + 0.35×(4-grade)`（原文符号与注解相反） | D17 §5.2 |
| 05 §3 | `v_due` 现算 `last_review + S×86400` | `card_state.due_at` 单列存（差一个 `1+ef` 倍） | D17 §5.1 |
| 05 §3 | 错题板只查倒数第 2 条 | 最近两条都要是 CORRECT | D17 §5.3 |
| 05 §2 | 7 表（含 `sense`/`sentence`） | 4 表：内容在 bundle，只存投影 + 进度 | D17 §4.2 |

## 当前状态

```
词库       ✅ 7884 义项已启用（data/wordlist/senses/，ECDICT B 方案），tier 已落到 bundle
句子       🟡 20 条（lay 试点 4 义项 × 5 句），需求 39420
TRAP       ❌ 0 个（642 个旧标记已归档，不迁移）
词性       ✅ 400 个缺失 pos 已补齐（scripts/fix_pos.py）
glossEn    ❌ 全部为空
bundle     ✅ SENSES_ONLY→PARTIAL，7884 卡，其中 4 张有句
原型       ✅ 24 项测试通过（scripts/e2e_d16.js），正确显示「暂无例句」
最小循环   ✅ node app/server.mjs —— 首页/三步答题/小结，进度落 data/user.db
SRS        ✅ app/srs.mjs + data/profile/srs_params.tsv，78 项 e2e 全绿
SQLite     ✅ app/schema.sql 4 表 3 视图，Node 与 Android 共用
设计文档   ✅ 5 篇 + D15/D16/D17 决策记录，关键数字全部脚本校验
安卓       ❌ 未开始（按要求先放放）
```

> 句子仍是唯一瓶颈：**20 / 39420**。循环已经跑通，扩句子是纯内容工作。

## 验证脚本

文档里的数字不是手写的，全部可重跑核对：

| 脚本 | 作用 |
| --- | --- |
| `node scripts/e2e_loop.mjs` | 最小循环：持久化 / 到期 / 幂等 / 事务 / SRS 数值（78 项） |
| `python scripts/smoke_http.py` | 真起服务走完一整场，验进度落盘与重放折叠（19 项） |
| `python scripts/verify_docs.py` | 校验 docs/ 里关键数字与实际数据一致 + 算术抽查（37 项） |
| `python scripts/verify_srs.py` | 实跑 `ease_factor` 斜坡、间隔演化、90 天门槛、间隔下界 |
| `node scripts/e2e_d16.js` | 零句基线回归：空句池不崩溃、给出诚实说明（39 项） |
| `python scripts/verify_ecdict.py` | 词库验收：噪声残留、义项分布 |
| `python scripts/sentence_audit.py` | 句子机械质检 G1-G7 + SPAN/SID/NOTE |
| `python scripts/fix_pos.py` | 补齐 ECDICT 缺失的词性（继承前驱 + 剥 `pl.` 前缀） |
| `python scripts/build_bundle.py` | 打包；无句义项也成卡 |

> `scripts/map_senses.py` 保留为历史工具。**不要用它做迁移**——D16 已否决。

## 目录

> 目录结构已在 2026-10 迁移为 source → data → build 三层。
> **以仓库根目录的 `MANIFEST.md` 为准**，本页只作历史记录。

```
source/      外部快照（ECDICT CSV 唯一快照），不可再生
data/        真相源：wordlist/senses/ wordlist/*.tsv sentences/ profile/ spec.yaml
build/       派生产物：bundle/cards.json intermediate/，不入库
content/     创作过程产物：prompts/
app/         最小循环：schema.sql / srs.mjs / db.mjs / server.mjs
scripts/     流水线 + 校验脚本
tools/       零句最坏路径的回归基线（e2e_d16.js 依赖，功能上已被 app/ 取代）
archive/     不可再生产物（405 人工句 / 642 TRAP / 旧格式词表 / 不可运行 ETL）
data/user.db 运行时进度，不入库
```

## 词库重建流水线

从 ECDICT CSV 到 `data/wordlist/senses/` 的可重跑顺序：

```bash
python scripts/parse_ecdict.py     # CSV -> ecdict_senses_raw.json（含字面 \n 修复）
python scripts/fix_pos.py          # 补齐 pos，剥 pl. 前缀（就地改 raw）
python scripts/diag_senses.py      # 5 类噪声量化诊断
python scripts/build_senses.py     # 清洗 + 跨词性合并 + 排序 -> ecdict_senses_final.json
python scripts/select_tier_b.py    # T1-T4 分档 -> ecdict_senses_b.json
python scripts/emit_senses_b.py    # -> data/wordlist/senses/*.tsv（正式词库）
python scripts/build_bundle.py     # -> build/bundle/cards.json
```

`fix_pos.py` 必须在 `build_senses.py` **之前**——否则缺 pos 的义项
会一路传到 UI。

## 阻塞项

1. **句子**：20 / 39420。`data/sentences/<word>.tsv` 一词一文件，
   写完立刻 `python scripts/sentence_audit.py` 校验。
   T1 档 663 词 × 4 义项 × 5 句 = 13260 句是首批。
   G5（义项唯一性）机械规则查不出来，必须逐句自审 —— 这是产能瓶颈所在。
2. **TRAP 重建**：需要人工或 LLM 判定新库哪些义项是"熟词僻义"。
   这是 `03-记忆曲线` 全部参数的前提（TRAP 用最短 S0=0.8）。
   旧 642 个标记在 `archive/2026-09-30-pre-ECDICT/old-senses/`，**只作判断依据参考，不迁移**。
3. **词库 2 词缺口**：`laptop` 在 ECDICT 无词条，另有 1 词清洗后无可用义项。
   当前覆盖 2998/3000，需人工补义或从 CORE 词表移除。
