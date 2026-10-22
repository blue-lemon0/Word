# 契约：内容包格式

应用无后端，跨侧对话只有一类文件：`build/bundle/` 下的内容包，
经应用内「词库 → 导入内容包」进入 IndexedDB。本文件是它唯一格式约定。

边界铁律：

- **app 只认 word-bundle 成品**：`format` / `schemaVersion` 不符直接拒绝，
  不靠猜字段运行。
- 交接区文件是机器产物，**手改无效**。

> 用户侧的备份/换机格式是 `word.backup` v2（应用内「更多 → 备份」导出），
> 字段约定见 `docs/DESIGN-词库系统v2.md`；旧服务端的 `word-progress` v1
> 已随旧骨架删除，两者不通用。

---

## 1. 内容包 `cards.json`（v1）

word-bundle 格式，导入时整包读入。

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
| `form` | string | `text` 中目标词实际出现的词形（laid / cast / …），非空 |
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
内容包是否升级，稳定等于漏升级。

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
- 同 `schemaVersion` 内，`(word, senseId)` 是跨版本稳定锚点：词表只增不删，
  `senseId` 不重排。这也是学习进度能跨内容版本存活的前提。

### 1.7 多内容包并存

交接区可同时存在多个内容包（如主包 `cards.json` 与 WordNet 重切验证包
`cards_v2.json`），各自独立 `version`，都必须通过 §1 的守门。**不同包的
`(word, senseId)` 是不同锚点体系**——义项重切意味着同一锚点指向不同义项，
进度与标记互不继承。
