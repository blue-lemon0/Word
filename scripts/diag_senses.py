# -*- coding: utf-8 -*-
"""诊断 ECDICT 切分结果的收敛问题：缺失词 / 超长释义 / 跨词性重复 / 近义细分。"""
import csv, io, json, os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
raw = json.load(io.open(os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_raw.json"),
                        encoding="utf-8"))
core = list(csv.reader(
    io.open(os.path.join(PROJ, "assets", "wordlists", "kaoyan_dagang_core.tsv"),
            encoding="utf-8"), delimiter="\t"))[1:]
words = [r[0] for r in core]

print("核心词 %d, 解析成功 %d" % (len(words), len(raw)))
miss = [w for w in words if w not in raw]
print("缺失 %d: %s" % (len(miss), miss))

# 释义长度分布
L = collections.Counter()
allz = []
for w, v in raw.items():
    for s in v["senses"]:
        n = len(s["zh"])
        L[min(n, 20)] += 1
        allz.append((n, w, s["pos"], s["zh"]))
print("\n释义长度分布(字):")
for k in sorted(L):
    print("   %2d 字: %5d %s" % (k, L[k], "#" * min(60, int(L[k] / 30))))
print("\n最长 15 个义项:")
for n, w, p, z in sorted(allz, reverse=True)[:15]:
    print("   %2d字 %-9s [%-3s] %s" % (n, w, p, z[:80]))
print("\n最短 8 个:")
for n, w, p, z in sorted(allz)[:8]:
    print("   %2d字 %-9s [%-3s] %s" % (n, w, p, z))

# 跨词性同 gloss 重复（同词内）
dup = []
for w, v in raw.items():
    m = collections.defaultdict(list)
    for s in v["senses"]:
        m[s["zh"]].append(s["pos"])
    for z, ps in m.items():
        if len(set(ps)) > 1:
            dup.append((w, z, ps))
print("\n跨词性重复 gloss: %d 个" % len(dup))
for w, z, ps in dup[:12]:
    print("   %-9s %-12s %s" % (w, z, ps))

# 近义细分（同一 pos 下 A 是 B 的子串）
sub = 0
subex = []
for w, v in raw.items():
    byp = collections.defaultdict(list)
    for s in v["senses"]:
        byp[s["pos"]].append(s["zh"])
    for p, zs in byp.items():
        for i, a in enumerate(zs):
            for j, b in enumerate(zs):
                if i != j and a != b and a in b and len(a) >= 2:
                    sub += 1
                    if len(subex) < 12:
                        subex.append((w, p, a, b))
print("\n近义细分(子串)对: %d" % sub)
for w, p, a, b in subex:
    print("   %-9s [%-3s] '%s' ⊂ '%s'" % (w, p, a, b))

# 星级/词频字段可用性
print("\n优先级字段可用性:")
cl = sum(1 for v in raw.values() if v.get("collins"))
ox = sum(1 for v in raw.values() if v.get("oxford"))
bn = sum(1 for v in raw.values() if v.get("bnc"))
fr = sum(1 for v in raw.values() if v.get("frq"))
print("   collins %d, oxford %d, bnc %d, frq %d (共 %d)" % (cl, ox, bn, fr, len(raw)))
ky = sum(1 for v in raw.values() if "ky" in (v.get("tag") or ""))
print("   tag 含 ky: %d 词" % ky)
