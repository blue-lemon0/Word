# Prompt · Stage 2 例句生成

> 输入：目标词 + 目标义项（含中文释义、英文释义、TRAP 标记）。
> 输出：符合四约束的例句列表（每义项生成 5+ 句，3 用 + 2 备用）。

## 四约束（必须全部满足）

### 1. 信号可辨识
句中有 ≥1 个**非目标词**的线索词，且线索词 ≠ 中文释义本身。
- 线索词 = 能帮助用户判断"此处目标词是哪个义项"的名词/动词/短语。
- 严禁线索词直接就是释义（如目标是"经营"就写 "manage"）。线索词必须**通过场景暗示**。
  - ✅ 目标"经营(run)" → "She runs a small bakery." 线索词 `bakery`
  - ❌ 目标"经营(run)" → "She runs the company."（company 无法区辨 经营/奔跑）

### 2. 信噪比
句子其余词用常见词，**不出现生僻词**。
> 注：原判据写的是「其余词均出自核心 3000 内」，实测**不可满足**——
> 3000 词表只收实词，连 the/and/of 都不含。
> 拿 404 条人工句复查，按原判据 45% 会被误判（up/children/soup/deer）。
> 改为：只要不是生僻词即可。
- 句子不含低频生词（如 rare/terminology/ruminate 之类）。
- 句子整体难度 ≤ D2（中等档），宁浅勿深。

### 3. 新颖情况
- 同一义项的不同句子，场景/线索互不重复（不写两次"开面包店"）。
- 句子彼此间只在目标词上共享含义，场景完全不同。

### 4. i+1
句长落在难度档区间：
- D1：8–12 词
- D2：12–16 词
- D3：14–20 词
- 本任务默认 D1（8–12 词），简短优先。

## 风格约束
- 真实感次要，**判别信号是主要的**。宁可浅显直白，不要文学性修辞。
- 清晰、短、线索足。禁止歧义到目标词两种义项都能成立的句子。

## 输出格式（严格 JSON）

```json
{
  "senseId": "run.v1",
  "word": "run",
  "pos": "vt.",
  "difficulty": 1,
  "distractors": [
    {"senseId": "run.v2", "glossZh": "（人/动物）跑", "kind": "SAME_WORD"}
  ],
  "sentences": [
    {
      "text": "She runs a small bakery with her sister.",
      "clueWord": "bakery",
      "highlightSpan": [9, 13],
      "translation": "她和姐姐一起经营着一家小面包店。",
      "note": "此处是「经营、管理」。run a business 是固定搭配。",
      "fingerprint": "",
      "source": "GENERATED"
    }
  ]
}
```

## 字段约束
- `highlightSpan`：**线索词** `clueWord` 在 `text` 中的字符起止位置（含）。绝不会 null。
  > 注：原文档写的是「目标词位置」，但实测归档的 404 条人工句 **404/404 都是 clue 位置**，
  > 且 UI 用 `<mark>` 高亮它作为**提示**。以 clue 为准。
  > 偏移算错不要紧——落盘后跑 `python scripts/sentence_audit.py --fix-spans` 机械重算。
- `distractors`：≥1 个 SAME_WORD 干扰义项（来自输入）或跨词干扰；实际干扰项列表由后端补齐。
- `note`：用中文简短解释本句为什么是目标义项，「不是」另一个义项。
- `fingerprint`：留空（后端指纹哈希填充）。

> 不要添加 markdown 代码围栏以外的内容。