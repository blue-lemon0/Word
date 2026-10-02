# 归档说明 · ECDICT 切换前夜

**归档时间**：2026-09-30
**原因**：D15 把义项源从考纲词频表换成 ECDICT，D16 决定不迁移旧数据，重新打造。

判定标准很简单：**能用脚本再跑一遍得到的，删；人手工做出来且没做过第二次的，存。**

---

## 存了什么（不可再生）

### `manual-sentences/MANUAL.tsv` — 405 条人工句子

18610 条句子里唯一不是 LLM 生成的部分。每条的 `note` 都带具体辨析，
句子本身是通顺的受控句（如 `airline` 那 8 条专门用来区分「航线 / 航空公司」）。

这是真正的**人类劳动成果**，也是验证人工标准的样本——将来给新句定质检基线时要用。

| 列 | 说明 |
| --- | --- |
| `word` / `senseId` | 对应**旧**义项 ID（已废弃，仅留作人工标准的参考） |
| `text` / `clue` / `span_start` / `span_len` | 句子与线索词位置 |
| `translation` | 译文 |
| `note` | 人工辨析，如「此处是「先发制人、抢先行动」，不是「预料」」 |

> 注意：这些句子**不直接复用**到新库（senseId 全变），保留的是"人工句子该长什么样"这个标准。

### `old-senses/TRAP_AND_GLOSSEN.tsv` — 3641 条旧义项 + 642 个 TRAP 标记

| 列 | 说明 |
| --- | --- |
| `word` … `note` | 旧义项表全部字段 |
| `nSentences` | 该义项当时有多少条句子供题（判断这个义项实际好不好用） |

**642 个 TRAP 是人工标注的**——哪些义项是"看起来认识、实际读错"的坑。
ECDICT 新库没有这个信息（`trap` 全 0），这批标记是目前唯一的参考样本。

> 同样**不直接迁移**：旧 TRAP 指向的义项多数不在 7884 新库里。
> 保留的是"什么样的义项该标 TRAP"的判断依据。

### `specs/` — v2.1 / v2.2 / v2.4 规格 + 决策台账

设计沿革。不是最终设计（已被 `docs/` 覆盖），但记录了**为什么当初那么想**，
避免以后重走一遍已经否决过的弯路。

### `wordlists/` — 考纲词表

- `kaoyan_dagang_core.tsv`（3000 词）— 仍然是**选词范围**的依据，词表本身没变
- `kaoyan_dagang_full.tsv`（5530 词）— 供后续扩充
- `source_netem_full_list.json` — 已判定「不是义项词典」，仅留作历史

---

## 删了什么（可再生）

| 目录 | 体积 | 为什么能删 |
| --- | --- | --- |
| `assets/sentences/` | 3.54 MB | 18201 条 LLM 生成句 + 4 条 SPAN_HINT。生成 + 质检都是脚本跑的，删了能原样重跑 |
| `assets/judge_results/` | 2.64 MB | judge 的 PASS/REJECT 结论，是上面那些句子的附属产物 |
| `assets/bundle/` | 4.13 MB | 打包产物，`scripts/build_bundle.py` 一条命令重建 |
| `assets/senses_ecdict/` | 0.36 MB | 13703 义项的全量版，与已启用的 7884 版重复。原料在 `ecdict_senses_final.json` |
| `assets/user_flags.jsonl` | 0.40 MB | 1998 条**实为 judge REJECT 日志**（字段是 lemma/senseId/text/reason/source，无用户标记的痕迹），非用户手点反馈 |
| `assets/corrections/` `assets/profile/` | 0 | 空目录 |

**合计删除 11.33 MB。**

### 特别说明 `user_flags.jsonl`

文件名容易误导——它叫 "user flags"，但 1998 条全是 judge 的质检理由
（「译文将 academy 译为「小学」，与目标义项「学院」不符，G6 失败」），
`source` 全部是 `GENERATED`，**没有一条是用户点的**。
真正的用户反馈为空。所以它可再生，删。

---

## 删掉后新基线

```
词库    2998 词 / 7884 义项 / 平均 2.63   ← 唯一真相源
句子    0 条                                 ← 等 LLM 通道解封
干扰项池 0 条
TRAP    0 个                                 ← 等重建
glossEn 全部为空
```

**这是刻意的。** 原型现在跑的是"只有词库、没有句子"的状态，
它必须能正确显示「该义项暂无例句」而不是崩溃或空白。
这正好提前验证了 `docs/design/01-句子生成与复用.md` §5.4 的 Layer 3 兜底路径
——只不过现在整个池子都是空的，等于最坏情况的压力测试。

---

## 恢复方式

如果将来发现丢了什么：

```bash
# 405 条人工句可从 archive/manual-sentences/MANUAL.tsv 直接读回
# 642 个 TRAP 可从 archive/old-senses/TRAP_AND_GLOSSEN.tsv 读回
# 18201 条生成句需重跑：scripts/ 下的生成 + 质检（LLM 通道当前禁用，无法重跑）
# 4.37MB 的 judge 结论无法重跑（历史 LLM 输出不可复现）——但它没有信息价值，只是 PASS/REJECT
```

生成句与 judge 结论**实际不可复现**（LLM 输出不可确定），
但也**没有信息价值**——同样的输入重跑会得到不同但同等质量的句子。
按 D16 的判断，这是可接受的损失。

---

## 归档的脚本（`scripts/`）

这些脚本服务的是**被 D16 废弃的旧流水线**，留着会误导后人以为还能跑：

| 脚本 | 为什么归档 |
| --- | --- |
| `llm_client.py` | DeepSeek 客户端。通道已禁用，且 D16 后的实时路径不走 LLM |
| `stage1_senses.py` | 旧义项生成（LLM）。新义项来自 ECDICT 切分，不需要生成 |
| `stage2_sentences.py` | 旧句子生成。句子将来要重写，先归档避免误用旧 prompt |
| `stage2_progress.py` | 旧句子生成进度统计，依赖已删除的 `assets/sentences/` |
| `stage3_judge.py` | 旧 judge。判据 G1-G7 已改版，且实时路径用规则质检 |
| `judge_audit.py` | 旧 judge 结论审计，依赖已删除的 `assets/judge_results/` |
| `backfill_senses.py` | 旧义项回填，依赖已删除的旧 `assets/senses/` |
| `normalize_senseids.py` | 旧 senseId 重编号。新库 senseId 由 `emit_senses_b.py` 顺序生成 |
| `build_wordlist.py` | 从 source_netem 构建词表——D15 已否决该数据源 |
| `map_senses.py` | 旧新模糊匹配。**D16 明确否决用它做迁移** |

> `assets/prompts/` 里的 3 个 prompt 模板**没有**归档：
> 它们是句子生成的设计输入，将来重写生成流程时要参考。
> 但内容需要按 G1-G7 新判据和"实时走规则质检"重新设计。

### 恢复方式

需要参考旧实现时从这里读，**不要拷回 `scripts/`**——
它们的输入（`assets/sentences/`、`assets/judge_results/`）已经不存在了。
