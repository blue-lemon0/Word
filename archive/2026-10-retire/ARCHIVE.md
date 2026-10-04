# 2026-10 退役归档

断舍离日期：2026-10-04。共同点：使命已结束，不再是任何活跃链路的一环。

## scripts/ —— 已完成的内容生产管线

`source/ → data/wordlist/senses/` 的唯一生成路径，词库交付后整体退役：

| 脚本 | 作用 |
|---|---|
| `build_senses.py` | ECDICT 快照 → 清洗、跨词性合并、排序 |
| `select_tier_b.py` | T1–T4 分档收敛 |
| `emit_senses_b.py` | → `data/wordlist/senses/*.tsv`（正式词库） |
| `build_ipa.py` | CMUdict → `data/wordlist/ipa.tsv`（音标，已 2998 词全覆盖） |
| `fix_gloss_2026-10.py` | 一次性修复 36 句教错义项的问题，已执行完毕 |

**重跑警告**：会覆写已入库的 `data/wordlist/kaoyan_dagang_core.tsv` 与
`senses/*.tsv`。确需重跑先整体移回 `scripts/`，跑完核对 `git diff`。

`verify_docs.py` 断言这些文件**不在** `scripts/`（PIPE_ARCHIVED_DONE）。

## 设计决策记录.md —— 旧版问题台账（根目录退役）

按"问题 → 根因 → 对策"记账的原始全量台账。其中的活跃决策已提炼为
`docs/decisions/D15/D16/D17`；本文件与
`archive/2026-09-30-pre-ECDICT/specs/` 里的同名快照相比多出约 60 行，
为保留差异单独归档于此。**现行决策只看 `docs/decisions/`。**

（同批退役的根目录 `大模型背单词软件规格-v2.4.md` 与
`archive/2026-09-30-pre-ECDICT/specs/` 副本逐字节相同，直接删除未归档。）
