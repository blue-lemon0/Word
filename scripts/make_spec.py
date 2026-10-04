# -*- coding: utf-8 -*-
"""从 sentence_audit.py 的真实常量生成 data/spec.yaml。

为什么要这个脚本：内容规格（句长区间、每义项句数、生僻词黑名单）原先硬编码在
sentence_audit.py 里。它是**内容规格**不是程序逻辑，但要改却得改代码。

spec.yaml 由本脚本从代码常量生成，不手抄 —— 手抄 357 个词必然出错
（我第一次就手抄成了 270 个，还混进三行垃圾）。生成后立刻回读校验，
确保 YAML 里的值与代码里的常量逐项一致。
"""
import io
import os
import sys

import yaml

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJ, "scripts"))
import sentence_audit as sa  # noqa: E402

OUT = os.path.join(PROJ, "data", "spec.yaml")

HEADER = """\
# 内容规格 —— 句子质量的判定标准属于数据，不属于代码
#
# 这些常量原先硬编码在 scripts/sentence_audit.py 里。它们是**内容规格**：
# 「一个句子该不该被接受」是内容决策，不是程序逻辑。规格要调，不该改代码、
# 跑回归、重发布，改这一个文件即可。
#
# 本文件由 scripts/make_spec.py 从代码常量生成，**不要手改** ——
# 要调规格就改 sentence_audit.py 的常量，然后重跑 make_spec.py。
#
# 加载方：scripts/sentence_audit.py（当前仍从常量加载，见 MANIFEST「已知缺口」）

# 句长区间，单位「词」，按句子数分档（第 1 批短句，第 3 批长句）
sentence_length:
"""

MIDDLE = """
# 每个义项至少几句才算覆盖
sentences_per_sense: %d

# 超纲生词黑名单。只拦「真正没有学习价值的生词」，不是所有 CORE 3000 以外的词。
#
# 为什么不是「非目标词 ∩ CORE3000 = ∅」：CORE 3000 只收实词，连 the/and/of 都不含，
# 任何正常句子都会 fail。拿归档的 404 条人工句复查，181/404 = 45%% 会被误判，
# 误判词是 up/exam/children/soup/deer/stove 这类普通词，不是生僻词。
too_hard:
"""


def main():
    parts = [HEADER]
    for k in sorted(sa.LEN_RANGE):
        lo, hi = sa.LEN_RANGE[k]
        parts.append("  %d: [%d, %d]\n" % (k, lo, hi))
    parts.append(MIDDLE % sa.TARGET_SENTS)
    for w in sorted(sa.TOO_HARD):
        parts.append("  - %s\n" % w)

    with io.open(OUT, "w", encoding="utf-8", newline="") as fh:
        fh.write("".join(parts))

    # 回读校验：生成的 YAML 必须能被解析，且与代码常量逐项一致
    d = yaml.safe_load(io.open(OUT, encoding="utf-8"))
    assert d["sentence_length"] == {k: list(v) for k, v in sa.LEN_RANGE.items()}, \
        "句长区间与代码不一致"
    assert d["sentences_per_sense"] == sa.TARGET_SENTS, "每义项句数与代码不一致"
    assert d["too_hard"] == sorted(sa.TOO_HARD), "生僻词名单与代码不一致"

    print("写出 %s" % OUT)
    print("  句长档 %d 个 / 每义项 %d 句 / 黑名单 %d 词 —— 已回读校验与代码一致"
          % (len(d["sentence_length"]), d["sentences_per_sense"], len(d["too_hard"])))


if __name__ == "__main__":
    main()