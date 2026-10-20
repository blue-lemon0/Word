# 契约：内容包与进度包

> **历史文档（2026-10-20 起冻结）**：内容产线 `content-kit/` 已整体删除
> （git 历史 `bfda5d7` 之前可恢复），本契约保留的原因：`build/bundle/cards.json`
> 内容包仍是应用的导入格式（词库 → 导入内容包），字段约定照旧有效；
> §2 的 `progress.json` 属旧服务端那一线，当前应用备份用 `word.backup` v2。
> 新内容不走产线，靠 AI 生成 + 手动添加。

两侧不共享代码、不共享数据库，只通过交接区的两类文件对话：

```
build/bundle/cards.json     内容包：词表 + 义项 + 例句（只读交接区，历史产物）
     │  读入
     ▼
app/                         背单词应用，学习数据在浏览器 IndexedDB
     │  用工具导出 / 导入
     ▼
progress.json               学习进度包：SRS 状态 + 作答流水 + 标记（旧服务端线）
```

边界铁律：

- **内容产线已删除**（原 `content-kit/` 不读 user.db、不写应用数据的纪律随产线退役）。
- **app 只认 `build/bundle/` 下的 word-bundle 成品**
  （主包 `cards.json`；验证包如 `cards_v2.json` 用环境变量成对切换，见 app/README「多内容源」）。
- 交接区文件是机器产物，**手改无效**（原由 `build_bundle.py` 重新生成，该产线已删除）。

> **范围提醒（2026-10-17 起）**：UI 已经搬到浏览器端（`app/web/`，见 D32），
> 它照样只吃 `build/bundle/` 的内容包，本契约 §1 照旧适用。
> 但下面 §2 的 `progress.json` 属于**旧服务端**那一线的用户库格式；
> 当前应用的备份格式是 `word.backup` v2（见 `app/web/README.md`），两者不通用。

---

## 1. 内容包 `cards.json`（v1）

word-bundle 格式，app 启动时整包读入内存（产线已删除，此格式仍为「导入内容包」的输入）。

### 1.1 顶层结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | 固定 `"word-bundle"`。不是此值 app 直接拒绝加载 |
| `schemaVersion` | number | 当前 `1`。破坏性结构变更才 +1 |
| `version` | string | 内容版本，见 1.4 |
| `stats` | object | 内容自统计，见 1.5，可被消费方直接信任展示 |
| `glossPool` | string[] | 全部义项中文释义池，供选择题干扰项取样 |
| `cards` | object[] | 义项级卡片，主键是 `(word, senseId)` |

### 1.2 card 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `word#senseId`，冗余拼接，全局唯一 |
| `word` | string | 英文原形词 |
| `senseId` | string | 词内义项序号：`s1` / `s2` / …，编号一经发布不重排 |
| `pos` | string | 词性标记，非空（`n.` / `v.` / `adj.` / …） |
| `ipa` | string | IPA 音标，可为空串 |
| `gloss` | string | 中文释义（含词性前缀），非空 |
| `glossEn` | string | 英文释义，可为空串 |
| `trap` | string | 陷阱标记（易混点提示），可为空串 |
| `tier` | string | 档位 `T1`/`T2`/`T3`，非空，决定每词保留义项数与权重 |
| `sentences` | object[] | 例句数组，无例句时为 `[]`（此时该义项**不入可练池**） |

### 1.3 sentence 对象

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 例句英文全文，非空 |
| `form` | string | `text` 中目标词实际出现的词形（laid / cast / …），由审计脚本机械算出，非空 |
| `clue` | string | 语境线索/中文引导，可为空串 |
| `spanStart` | number | 目标词在 `text` 中的起始下标（UTF-16 码元，与 JS `slice` 一致） |
| `spanLen` | number | 目标词片段长度；`text.slice(spanStart, spanStart + spanLen) === form` 必须成立 |
| `translation` | string | 整句中文翻译 |
| `note` | string | 用法备注，可为空串 |
| `source` | string | 来源标识，可为空串 |

### 1.4 `version` 规则

格式 `YYYYMMDD-XXXXXXXX`：日期 + 规范化内容的 SHA1 前 8 位。哈希输入是按
`(word, senseId, 句子顺序)` 排序后、去掉 `version` 字段本身的完整 JSON。

**任何内容改动（改一句译文、调一个 span 也算）后哈希必变。** app 用它判断
「内容包是否升级、投影表 card 是否需要重建」，稳定等于漏升级。

### 1.5 `stats` 自洽规则（审计必查）

| 键 | 含义 |
|---|---|
| `words` | 词数 |
| `cards` | 义项总数 = `cards[]` 长度 |
| `sentences` | 例句总数 = 所有 `sentences[]` 长度之和 |
| `withSentences` | 有例句的义项数（即可练池大小） |
| `noSentence` | 无例句义项数；`withSentences + noSentence === cards` |
| `mode` | `FULL`：每义项都有句；`PARTIAL`：部分有句；`SENSES_ONLY`：全库无句 |

### 1.6 演进与兼容

- **加可选字段**不算破坏性变更，`schemaVersion` 不动；旧 app 忽略未知字段。
- **改字段名/改语义/删字段/改编号规则**必须 +1，并在本文件记录迁移方式。
- app 在 `app/db.mjs` 的 `loadBundle()` 守门：`format` 不符或 `schemaVersion`
  不被识别时直接报错退出，不靠猜字段运行。
- 同 `schemaVersion` 内，`(word, senseId)` 是跨版本稳定锚点：词表只增不删，
  `senseId` 不重排。这也是学习进度能跨内容版本存活的前提。

### 1.7 多内容包并存

交接区可同时存在多个内容包（如主包 `cards.json` 与 WordNet 重切验证包
`cards_v2.json`），各自独立 `version`，都必须通过 §1 的守门。**不同包的
`(word, senseId)` 是不同锚点体系**——义项重切意味着同一锚点指向不同义项，
进度与标记互不继承。app 侧用 `WORD_BUNDLE` + `WORD_DB` **成对**切换，
进度库随内容包隔离，绝不共用。

---

## 2. 学习进度包 `progress.json`（v1）

由 `app/tools/progress_io.mjs` 在 `app/state/user.db` 与 JSON 之间双向搬运。
用途：**备份与换机恢复**（v1 不定义多设备实时合并语义）。

### 2.1 顶层结构

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | string | 固定 `"word-progress"` |
| `schemaVersion` | number | 当前 `1` |
| `exportedAt` | number | 导出时刻，unix 秒 |
| `bundleVersion` | string | 导出时库中记录的内容包版本（对应 cards.json 的 `version`） |
| `states` | object[] | 各义项 SRS 状态，见 2.2 |
| `reviews` | object[] | 作答流水（只增不改的真相），见 2.3 |
| `flags` | object[] | 问题句子标记，见 2.4 |
| `uiState` | object \| null | 前端 UI 状态快照（队列位置/临时错题等），可为 null |

不导出的东西：`card` 表（内容包投影，换包即重建）、`v_*` 视图（派生）、
`meta.schema_version`（由 app 自己管）。

### 2.2 state 对象（对应表 `card_state`）

| JSON 字段 | 类型 | 说明 |
|---|---|---|
| `word` / `senseId` | string | 卡片锚点 |
| `stability` | number | 答**对后**记忆稳定度 S（天） |
| `difficulty` | number | 难度 D，初始 8.0 |
| `lastReview` | number \| null | 上次复习时刻，unix 秒 |
| `dueAt` | number | 到期时刻，unix 秒；0 = 立即到期 |
| `reps` | number | 有效复习次数 |
| `wrongN` | number | 答错次数 |
| `pendingN` | number | 挂起（「我不会」）次数 |
| `mastered` | boolean | 是否已掌握（掌握后不再排期） |
| `rusty` | boolean | 掌握后回生标记 |

### 2.3 review 对象（对应表 `review_log`）

| JSON 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | string | 场次 id |
| `idx` | number | 场内序号；`(sessionId, idx)` 是主键 |
| `attemptId` | string | 出题时下发的尝试 id，幂等锚点 |
| `word` / `senseId` | string | 卡片锚点 |
| `sentence` | string \| null | 当时作答的那句原文 |
| `result` | string | `CORRECT` / `WRONG` / `PENDING` |
| `grade` | number | SRS 评级 `0 / 2 / 4 / 5` |
| `elapsedMs` | number \| null | 作答耗时，毫秒 |
| `isDue` | boolean | 是否到期作答（提前复习不计入正确率） |
| `stabilityAfter` | number \| null | 本次作答后的 S，留痕便于复盘 |
| `ts` | number | 作答时刻，unix 秒 |

### 2.4 flag 对象（对应表 `sentence_flag`）

字段：`word` / `senseId` / `sentence` / `note`（可空）/ `ts`（unix 秒）。
业务唯一键 `(word, senseId, sentence)`。

### 2.5 导入语义与幂等

导入在单事务内完成，规则：

- **reviews**：`INSERT OR IGNORE`。按主键 `(sessionId, idx)` 与 `attemptId`
  去重——重复导入同一个包、或导入与本地重叠的包，不会产生重复流水。
- **states**：以导入包为准 `UPSERT` 覆盖同锚点行；本地多出的行保留
  （换机恢复的目标机通常是空库）。
- **flags**：按业务唯一键 `INSERT OR IGNORE`。
- **uiState**：仅当本地为空，或加 `--force` 时覆盖。
- `bundleVersion` 不一致（进度来自旧内容包）时**警告但允许导入**：
  锚点 `(word, senseId)` 悬空的状态在视图 JOIN 中自然失效，不会报错；
  但 SRS 参数含义若未来变化，以 app 侧实现为准。
- 时间戳一律 **unix 秒**，唯一例外 `elapsedMs` 是毫秒；布尔落库转 0/1。

### 2.6 演进规则

与内容包相同：加可选字段不升版，破坏性变更 +1。导入工具先校验
`format`/`schemaVersion`，不认就拒绝，不做静默猜测。
