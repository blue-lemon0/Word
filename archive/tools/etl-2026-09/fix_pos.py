# -*- coding: utf-8 -*-
"""补齐 ECDICT 义项缺失的词性（pos）。

问题
----
ECDICT 的 `translation` 字段里，约 0.5% 的中文释义**不带词性标记**。
原始切分后这些义项的 pos 为空串，导致 UI 上词性标签空白、
`buildOptions` 的同词干扰项排序也拿不到词性参考。

例：
    skilled   [a] 熟练的
              []  [经] 熟练的
              []  有技能��          <- 无 pos
    airport   [n] 飞机场
              []  航空站
              []  机场              <- 无 pos

成因
----
ECDICT 的 `translation` 是**按词性分块**排列的：同一词性连续出现，
但块内后续条目不再重复标记词性（就像英文 `definition` 里
`n. foo` / `bar` / `baz` 只有第一条带 `n.`）。
所以**未标记的义项必然继承它前面那个有标记的义项的词性**。

规则（按优先级）
--------------
  R1 继承前驱：同一词内，取上一个有 pos 的义项的 pos。
     覆盖 37/39，且抽查全部合理（skilled→a、airport→n、third→num）。
  R2 整词无标记：若该词所有义项都无 pos（如 agenda / bacteria），
     读 `definition` 每行的行首标记（`n.` / `v.` / `a.` / `s.` ...），
     按行序对应义项。
  R3 仍无解：留空（并计入 stats），不猜。

顺带清理
--------
`pl. 议程` / `pl. 细菌` —— 复数标记 `pl.` 泄漏进了中文释义。
剥掉前缀，`pl.` 本身表示名词复数，故 pos 记 `n`。

不做的事
--------
不猜词性、不跨词继承、不改动有 pos 的义项。
"""
import collections, io, json, os, re, sys

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(PROJ, "source", "ecdict_snapshot.json")

# ECDICT definition 的行首词性标记 -> 内部简称
DEF_POS = {
    "n.": "n", "v.": "v", "a.": "a", "ad.": "a", "adv.": "adv",
    "s.": "a", "r.": "adv", "prep.": "prep", "conj.": "conj",
    "pron.": "pron", "num.": "num", "int.": "int", "abbr.": "abbr",
}
DEF_LINE = re.compile(r"^([a-z]+\.)\s")
PL_PREFIX = re.compile(r"^pl\.\s*", re.I)


def def_positions(definition):
    """从 definition 逐行取行首词性标记，保持行序。"""
    out = []
    for ln in (definition or "").split("\n"):
        ln = ln.strip()
        if not ln:
            continue
        m = DEF_LINE.match(ln)
        if m:
            tag = m.group(1).lower()
            if tag in DEF_POS:
                out.append(DEF_POS[tag])
    return out


def fix_word(v):
    """就地修复一个词的 senses，返回统计 Counter。"""
    st = collections.Counter()
    senses = v.get("senses") or []
    if not senses:
        return st

    # 先剥掉泄漏的 pl. 前缀
    for s in senses:
        zh = s.get("zh", "")
        if PL_PREFIX.match(zh):
            s["zh"] = PL_PREFIX.sub("", zh).strip()
            s["pos"] = s.get("pos") or "n"   # pl. = plural noun
            st["pl_stripped"] += 1

    # R1：继承前驱
    cur = ""
    for s in senses:
        if s.get("pos"):
            cur = s["pos"]
        elif cur:
            s["pos"] = cur
            st["pos_from_prev"] += 1

    # R2：整词仍无 pos -> 从 definition 取
    if not any(s.get("pos") for s in senses):
        defs = def_positions(v.get("definition"))
        for s, d in zip(senses, defs):
            if not s.get("pos"):
                s["pos"] = d
                st["pos_from_def"] += 1

    st["still_blank"] = sum(1 for s in senses if not s.get("pos"))
    return st


def main():
    raw = json.load(io.open(RAW, encoding="utf-8"))

    before = sum(1 for v in raw.values() for s in (v.get("senses") or []) if not s.get("pos"))
    total = collections.Counter()
    for w, v in raw.items():
        total.update(fix_word(v))
    after = sum(1 for v in raw.values() for s in (v.get("senses") or []) if not s.get("pos"))

    print("=" * 62)
    print("修复前缺 pos 的义项: %d" % before)
    print("  pl. 前缀剥除       : %d" % total["pl_stripped"])
    print("  R1 继承前驱        : %d" % total["pos_from_prev"])
    print("  R2 取自 definition : %d" % total["pos_from_def"])
    print("修复后仍缺 pos       : %d" % after)
    if after:
        print("  仍缺（未猜测，留空）:")
        for w, v in raw.items():
            for s in (v.get("senses") or []):
                if not s.get("pos"):
                    print("     %-12s %s" % (w, s.get("zh", "")))

    # 抽查
    print("\n抽查（前驱继承是否合理）:")
    for w in ["skilled", "useful", "legal", "third", "airport", "car",
              "government", "financial", "recent", "agenda", "bacteria", "different"]:
        if w not in raw:
            continue
        print("  %s" % w)
        for s in raw[w]["senses"][:5]:
            print("     [%-4s] %s" % (s.get("pos") or "?", s.get("zh", "")))

    with io.open(RAW, "w", encoding="utf-8") as fh:
        json.dump(raw, fh, ensure_ascii=False, separators=(",", ":"))
    print("\n-> %s (已就地更新)" % RAW)


if __name__ == "__main__":
    main()
