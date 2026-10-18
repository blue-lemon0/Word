# content-kit — 内容产线

把词表和例句生产、质检、烘焙成应用唯一消费的内容包
`build/bundle/cards.json`（格式 `word-bundle` v1，字段表见根目录
[CONTRACT.md §1](../CONTRACT.md)）。

**产线不碰学习数据。** 唯一例外是 `triage_flags.py` 只读应用库的问题句标记，
用于汇总待修句子；它不写任何应用文件。

## 目录

```
spec.yaml                  内容规格（句长区间、每义项句数、超纲词黑名单）—— 真相源
prompts/                   生产例句时给模型的提示词模板（stage2 造句 / stage3 评审）
pipeline/                  产线脚本
data/                      人类可读可改的真相源，全部入库
  wordlist/senses/<w>.tsv    义项：senseId pos glossZh tier trap（2998 词 / 7884 行）
  wordlist/ipa.tsv           音标（按词性）
  wordlist/kaoyan_dagang_core.tsv  考研大纲核心词表与档位
  sentences/<w>.tsv          例句：senseId text clue span translation note source
source/                    外部快照，不可再生 —— 全仓库唯一必须离线备份的东西
  ecdict_snapshot.json       ECDICT 的唯一快照（原始 CSV 在仓库外）
```

`build/` 在仓库根而不在本目录：它是**两侧之间的交接区**，产线只写、应用只读，
任何时候都能整个删掉重建。

## 产线流程（做一批新词）

```bash
# 0. 依赖：Python 3 + PyYAML（仅 sentence_audit.py 需要）
pip install pyyaml

# 1. 排出下一批该做的词（按档位、可判别性、是否已完成排序）
python content-kit/pipeline/pick_words.py --n 30 --target 300
#    --done 只看已完成词；UNSEPARABLE 表收录判别价值低的词（如 civil）

# 2. 按 prompts/stage2_sentence.md 造句、stage3_judge.md 自审，
#    结果手写进 data/sentences/<word>.tsv（每义项 5 句，规格见 spec.yaml）

# 3. 质检：G1–G7 + 释义对齐 + span 检查
python content-kit/pipeline/sentence_audit.py
#    发现 span 偏移错误时机械修复（form 由 inflections 规则算出，不靠人猜）：
python content-kit/pipeline/sentence_audit.py --fix-spans

# 4. 烘焙内容包（纯转换，零内容判断）
python content-kit/pipeline/build_bundle.py
#    -> build/bundle/cards.json，打印 词/义项/句/有句义项 统计
```

应用侧标记的坏句子回流（**两个来源，同一套输出**）：

```bash
# 浏览器端的应用（当前应用）：用户在错题板点「导出清单」拿到 flags_*.json
python content-kit/pipeline/triage_flags.py --from app/web/flags_20261017.json
#   格式 word-flags v1；脚本会拿内容包核对，原文已不在包里的直接标「疑似已修」

# 旧服务端那一线：直接只读 app/state/user.db 的 sentence_flag 表
python content-kit/pipeline/triage_flags.py
python content-kit/pipeline/triage_flags.py --word lay   # 只看某词，--json 出 JSON
```

两种来源的关单动作不同：旧服务端用 `node app/tools/flags.mjs`，
浏览器端在错题板的「已修好」逐条点掉。清单末尾会打印对应的那套流程。

## 铁律

1. **一个事实只存一处。** 义项只在 `data/wordlist/senses/`，例句只在
   `data/sentences/`；`build/` 全是派生物，不含手写内容。
2. **规格属于数据不属于代码。** 句长、句数、黑名单改 `spec.yaml` 立即生效，
   审计脚本每次运行都重新加载它，不要把规格改回代码常量。
3. **`source/ecdict_snapshot.json` 不可再生**，丢了无法从仓库内恢复。
4. **内容包版本哈希必须诚实。** 改一句译文/一个 span 也要重新
   `build_bundle.py`，让 `version` 变化——应用靠它判断是否需要重建索引
   （规则见 CONTRACT.md §1.4）。
5. **义项编号 `s1/s2/…` 一经发布不重排、词表只增不删。** 这是学习进度能跨
   内容版本存活的锚点（CONTRACT.md §1.6）。

## 自检（命令均从仓库根运行）

```bash
python content-kit/pipeline/verify_ecdict.py     # ECDICT 快照完整性
python content-kit/pipeline/sentence_audit.py    # 全量例句质检
python scripts/verify_docs.py                    # 跨侧结构守卫
```
