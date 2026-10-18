# 对接提示词 · 把 v2 内容包装进背单词系统

> 用途：把 opencode 生成的 `build/bundle/cards_v2.json` 接入你的背单词 app，
> 用于人工验证词库质量。
>
> **先读这一段再往下**：`build/bundle/cards_v2.json` 与 `build/bundle/cards.json`
> 是**两个独立的内容包**，后者是线上正在用的，不要动它。契约见仓库根
> `CONTRACT.md §1`（`word-bundle` v1），字段定义以那里为准。

---

## 提示词正文（复制以下全部内容给对接的 AI）

```
你负责把一个新内容包接入现有的背单词 app 骨架。仓库根目录
D:\projectX\android\Word（Windows + PowerShell 5，命令用 ; 分隔，不要 &&）。

## 目标

新增一个数据源 build/bundle/cards_v2.json，让 app 能加载它并显示，
用于人工验证词库质量。同时保留现有 build/bundle/cards.json 的加载能力，
两者可切换。

## 现状（我已确认，不必重新调查）

- build/bundle/cards_v2.json 已存在，格式 word-bundle v1，与 CONTRACT.md §1 一致
- cards.json（旧的、线上在用的）不要修改、覆盖、移动
- app/ 下已有 cards.json 的加载逻辑与 db.mjs 的投影表构建
- 两边的差别：v2 包的义项按 Princeton WordNet 3.0 的 synset 重切过，
  glossEn（英文释义）有值，而旧包 7884 条 glossEn 全空；
  v2 还取消了「每词最多 N 个义项」的截断

## 你要做的事

### 1. 读契约，不要猜字段

读 CONTRACT.md §1，重点：
- §1.2 card 对象的字段（id / word / senseId / pos / ipa / gloss / glossEn /
  trap / tier / sentences）
- §1.3 sentence 对象的字段（text / form / clue / spanStart / spanLen /
  translation / note / source）
- §1.4 version 规则 —— 为什么改了 glossEn 也必须让 version 变
- §1.6 演进与兼容 —— (word, senseId) 是跨版本稳定锚点

### 2. 加载 v2 包

- 在 app 侧加一个「内容源」概念，让 app 能选择读 cards.json 或 cards_v2.json。
  最小改动：加一个配置项或环境变量，不要改动 cards.json 的现有加载路径。
- **必须走 app/db.mjs 的投影表构建流程**，不要另写一套。v2 的 senseId 编号
  与旧包不同（义项顺序变了），如果绕过投影表直接读 JSON，学习进度会挂到
  错误的义项上。
- app/state/user.db 里有学习进度，锚点是 (word, senseId)。切到 v2 之前先
  想清楚：v2 的 senseId 对应的是不同的义项，进度不能直接继承。**请把这个
  风险明确告诉我，不要自行决定怎么处理进度。**

### 3. 界面上要能看到

- 英文释义（card.glossEn）在界面上有可见位置。
  旧包的 glossEn 是空串，所以界面上大概率没有这一项，需要你新增展示。
- pos 也要显示（v2 的 pos 来自英文行首标记，是 n./v./a./adv. 这种形态；
  注意 ECDICT/WordNet 用罗杰特体系，s.=形容词、r.=副词，已在产线归一化）
- 旧包没有例句的义项要能显示「暂无例句」状态（v2 目前 66 义项里 60 个无句）

### 4. 不要做的事

- 不要修改、覆盖、移动 build/bundle/cards.json
- 不要修改 build/bundle/cards_v2.json（只读消费）
- 不要动 content-kit/ 下的任何文件（那是内容产线，不是你的范围）
- 不要为了让界面好看而改动 v2 里的 gloss / glossEn / senseId 任何值
- 不要自行决定学习进度怎么处理

### 5. 完成后请报告

- 改动了哪些文件，各自理由
- 界面在哪里能看到英文释义
- 学习进度怎么处理，以及你的建议
- 启动命令是什么
```

---

## 内容包速览（供你核对，不必再跑脚本）

`build/bundle/cards_v2.json` 当前内容：

```
version      20261005-a75edd1e
词数          18
义项(卡片)    66
有英文释义    56 (84.8%)
有句义项      6  (涉及 3 词)
无句义项      60
例句总数      33
mode          PARTIAL
```

单张卡片长这样（`army#s2`）：

```json
{
  "id": "army#s2",
  "word": "army",
  "senseId": "s2",
  "pos": "n.",
  "ipa": "",
  "gloss": "大批人；大军",
  "glossEn": "a large number of people united for some specific purpose",
  "trap": 0,
  "tier": "T1",
  "sentences": [
    {
      "text": "He kept an army of assistants at his company.",
      "form": "army",
      "clue": "assistants",
      "spanStart": 11,
      "spanLen": 4,
      "translation": "他在公司里配了一批助手。",
      "note": "大批人（雇员）。线索是 assistants + at his company，是雇员群体。",
      "source": "GENERATED"
    }
  ]
}
```

**验证时重点看这几处：**

| 看什么 | 期望 |
|---|---|
| `glossEn` | 有值且与 `gloss` 语义对应 |
| `pos` | `n.` / `v.` / `a.` / `adv.`，不会是 `vt.`/`vi.`（英文侧不区分） |
| `spanStart/spanLen` | 指向 `form` 指向的那段（目标词），不是 `clue` |
| `clue` | 在 `text` 里能字面找到；它是语境提示，**不是**高亮对象 |
| `senseId` | `s1`/`s2` 递增；**与旧包不同义项顺序，不能混用学习进度** |

## 已知的坑（对接前先看，省得你踩）

**① 旧句子全部作废**

```
queen  旧 s1=王后   →  v2 s1=蜂后
army   旧 s2=陆军   →  v2 s2=大批人；大军
edition 旧 s3=翻版  →  v2 s3=报纸的一次发行
```

v2 的例句在 `content-kit/data/sentences_v2/`，与旧的
`content-kit/data/sentences/` 是两套。**不要把旧例句按 senseId 挂到 v2 卡片上**，
会教错义项（界面上会出现「蜂后」配「战前国王与王后交谈」）。

**② glossEn 有 10 条为空**

不是 bug —— 那些义项（如 `stone 宝石`、`affair 事务`）在 ECDICT 与 WordNet
里都没有对应的首词 synset，但确实是真实英语用法（`precious stone`、
`foreign affairs`），所以保留了中文释义、glossEn 留空。

**③ pos 粒度变粗**

按英文切分的代价：ECDICT 英文只写 `v.`，不区分 `vt.`/`vi.`。所以
`accept` 的「vt.接受」和「vi.同意」会并成一个义项。这是已知取舍。