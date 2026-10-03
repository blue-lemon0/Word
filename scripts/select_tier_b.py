# -*- coding: utf-8 -*-
"""B 方案：把 ECDICT 全量义项收敛到 6000-8000。

依据：用户要求「每词 3-5 个义项」「真题考高频义项」，
而 ECDICT 每词 8 个里有大量低频/边缘义项（abandon 抛弃/遗弃/放弃/沉溺/放纵…）。

ecdict_senses_final.json 里每个词的 senses 数组已按优先级降序排好
（见 build_senses.py 的 zs.sort(key=lambda t: -priority(v, t[2]))），
所以本步骤就是"每词取前 K"，K 由词的权重决定。

词的权重来自 collins 星级 / bnc / frq 词频 / ky 标签。
"""
import csv, io, json, os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FINAL = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_final.json")

# 词级分档 -> 保留义项数
# 阈值经实测校准：目标是 7000-8500 义项、且高频词不被腰斩。
# 依据 ECDICT 自带的义项排序（词典编纂惯例：高频义项在前），
# 词级权重只决定"这个词该给几个义项"，不决定"留哪几个"。
TIERS = [(0.60, 4), (0.45, 3), (0.25, 2), (0.0, 1)]
TIER_NAME = {4: "T1", 3: "T2", 2: "T3", 1: "T4"}


def num(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def word_weight(v):
    """词重要度 0..1"""
    s = 0.0
    s += num(v.get("collins")) / 5.0 * 0.40        # 柯林斯星级 1-5
    s += (1.0 if num(v.get("oxford")) > 0 else 0.0) * 0.10
    bnc, frq = num(v.get("bnc")), num(v.get("frq"))
    # bnc/frq 是排名，数值越小越常用 -> 取倒数压缩到 0..1
    s += (1.0 / (1.0 + bnc)) * 0.25
    s += (1.0 / (1.0 + frq)) * 0.25
    tag = (v.get("tag") or "").split()
    if "ky" in tag:
        s += 0.15
    if "gk" in tag or "cet" in tag:
        s += 0.03
    return min(1.0, s)


def keep_for(w):
    for thr, k in TIERS:
        if w >= thr:
            return k
    return 1


def main():
    final = json.load(io.open(FINAL, encoding="utf-8"))
    core = list(csv.reader(
        io.open(os.path.join(PROJ, "assets", "wordlists", "kaoyan_dagang_core.tsv"),
                encoding="utf-8"), delimiter="\t"))[1:]
    words = [r[0] for r in core]

    sel = {}
    tierc = collections.Counter()
    dist = collections.Counter()
    for w in words:
        v = final.get(w)
        if not v:
            continue
        wgt = word_weight(v)
        k = keep_for(wgt)
        tierc[TIER_NAME[k]] += 1
        senses = v["senses"][:k]
        sel[w] = {"weight": round(wgt, 3), "tier": TIER_NAME[k],
                  "keep": k, "senses": senses,
                  "meta": {x: v.get(x) for x in
                           ("collins", "oxford", "tag", "bnc", "frq", "freq")}}
        dist[len(senses)] += 1

    tot = sum(len(v["senses"]) for v in sel.values())
    print("=" * 64)
    print("B 方案收敛结果: %d 词 / %d 义项 / 平均 %.2f" % (len(sel), tot, tot / len(sel)))
    print("\n分档:")
    for t in ["T1", "T2", "T3", "T4"]:
        n = tierc[t]
        k = {"T1": 4, "T2": 3, "T3": 2, "T4": 1}[t]
        print("   %s 保留 %d 义项: %4d 词 (%5.1f%%)  贡献 %5d 义项"
              % (t, k, n, n / len(sel) * 100, n * k))
    print("\n义项数分布:")
    for k in sorted(dist):
        print("   %d 义项: %4d 词 %s" % (k, dist[k], "#" * max(1, dist[k] // 12)))
    multi = sum(c for k, c in dist.items() if k >= 2)
    print("多义词 %.1f%%  单义词 %d" % (multi / len(sel) * 100, dist.get(1, 0)))
    print("\n5 句/义项需 %d 句" % (tot * 5))

    print("\n抽样对比（全量 -> B）:")
    for w in ["abandon", "run", "state", "share", "well", "issue", "passage",
              "accept", "account", "act", "address", "bear", "age", "bar"]:
        v = final.get(w)
        s = sel.get(w)
        if not v or not s:
            continue
        print("   %-9s %s w=%.2f  %d -> %d" %
              (w, s["tier"], s["weight"], len(v["senses"]), len(s["senses"])))
        print("        " + " / ".join(x["zh"] for x in s["senses"]))
        drop = [x["zh"] for x in v["senses"][len(s["senses"]):]]
        if drop:
            print("        (弃: " + " / ".join(drop) + ")")

    p = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_b.json")
    with io.open(p, "w", encoding="utf-8") as fh:
        json.dump(sel, fh, ensure_ascii=False, separators=(",", ":"))
    print("\n-> %s (%.2f MB)" % (p, os.path.getsize(p) / 1024 / 1024))


main()
