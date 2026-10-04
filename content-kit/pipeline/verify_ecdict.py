# -*- coding: utf-8 -*-
"""ECDICT 词库最终验收：数量/分布/噪声/与旧库对比。

D16 起：
  NEW = 正式词库 data/wordlist/senses/（B 方案 7884 义项）
  OLD = 归档的旧库 archive/2026-09-30-pre-ECDICT/old-senses/（3641 义项）
       只用于对比统计，**不做迁移**。
"""
import collections, csv, io, json, os, re, sys
sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # = content-kit/
REPO = os.path.dirname(PROJ)
NEW = os.path.join(PROJ, "data", "wordlist", "senses")
OLD = os.path.join(REPO, "archive", "2026-09-30-pre-ECDICT",
                   "old-senses", "TRAP_AND_GLOSSEN.tsv")
OLD_DIR = os.path.dirname(OLD)

def load(d):
    out = {}
    for f in os.listdir(d):
        if not f.endswith(".tsv"):
            continue
        w = f[:-4]
        rows = []
        for i, ln in enumerate(io.open(os.path.join(d, f), encoding="utf-8")):
            if i == 0:
                continue
            c = (ln.rstrip("\n").split("\t") + [""] * 6)[:6]
            rows.append({"id": c[0], "pos": c[1], "zh": c[2], "en": c[3],
                         "trap": c[4], "note": c[5]})
        out[w] = rows
    return out

def load_old_snapshot(path):
    """归档的旧库是单张 TSV，不是每词一个文件。"""
    out = collections.defaultdict(list)
    for i, ln in enumerate(io.open(path, encoding="utf-8")):
        if i == 0:
            continue
        c = ln.rstrip("\n").split("\t")
        out[c[0]].append({"id": c[1], "pos": c[2], "zh": c[3], "en": c[4],
                          "trap": c[5], "note": c[6]})
    return dict(out)

n = load(NEW)
o = load_old_snapshot(OLD)
print("新库(正式): %d 词 / %d 义项" % (len(n), sum(len(v) for v in n.values())))
print("旧库(归档): %d 词 / %d 义项" % (len(o), sum(len(v) for v in o.values())))

d = collections.Counter(len(v) for v in n.values())
print("\n义项数分布 (新):")
for k in sorted(d):
    print("   %d: %4d 词 %s" % (k, d[k], "#" * max(1, d[k] // 12)))
multi = sum(c for k, c in d.items() if k >= 2)
print("多义词 %.1f%%  单义词 %d" % (multi / len(n) * 100, d.get(1, 0)))

# 噪声检查
noise = {"inflect": 0, "cmd": 0, "bracket": 0, "empty": 0, "toolong": 0, "nopos": 0}
gl = collections.Counter()
for w, rows in n.items():
    for r in rows:
        z = r["zh"]
        if not z.strip(): noise["empty"] += 1
        if len(z) > 9: noise["toolong"] += 1
        if re.search(r"的(过去式|过去分词|现在分词)", z): noise["inflect"] += 1
        if re.search(r"(该命令|命令用于|DOS)", z): noise["cmd"] += 1
        if re.match(r"^\s*[\[【]", z): noise["bracket"] += 1
        if not r["pos"]: noise["nopos"] += 1
        gl[z] += 1
print("\n噪声残留:", noise)

# 跨词重复的 gloss（同一释义被多个词用，正常；但要检查是否有病句）
print("最长 gloss:", gl.most_common(5))
print("单字义项数: %d" % sum(1 for w, rows in n.items() for r in rows if len(r["zh"]) == 1))

# 与旧库对比
print("\n义项数变化 (抽样 15 个多义词):")
big = sorted(n, key=lambda w: -len(n[w]))[:15]
for w in big:
    a, b = len(o.get(w, [])), len(n[w])
    print("   %-11s 旧 %d -> 新 %d  %s" % (w, a, b, "+%d" % (b - a) if b > a else ""))

inc = sum(1 for w in n if len(n[w]) > len(o.get(w, [])))
dec = sum(1 for w in n if len(n[w]) < len(o.get(w, [])))
same = sum(1 for w in n if len(n[w]) == len(o.get(w, [])))
print("\n义项增加 %d 词, 减少 %d 词, 持平 %d 词" % (inc, dec, same))

# TRAP 需要重建：旧库有 642 个 trap 标记（已归档，不迁移）
traps = sum(1 for w in o for r in o[w] if r["trap"] == "1")
print("旧库 TRAP 义项 %d 个（已归档，新库需从零重建）" % traps)
# 有 glossEn 的
en = sum(1 for w in o for r in o[w] if r["en"].strip())
print("旧库有 glossEn 的义项 %d 个（已归档）" % en)
en_new = sum(1 for w in n for r in n[w] if r["en"].strip())
print("新库有 glossEn 的义项 %d 个（ECDICT definition 不覆盖逐义项）" % en_new)

# 句子：D16 后从零生成
need = sum(len(v) for v in n.values()) * 5
S = os.path.join(PROJ, "data", "sentences")
tot = 0
if os.path.isdir(S):
    tot = sum(len(io.open(os.path.join(S, f), encoding="utf-8").readlines()) - 1
              for f in os.listdir(S) if f.endswith(".tsv"))
print("\n现有句子 %d 条" % tot)
print("新库若要 5 句/义项: %d 条, 缺口 %d" % (need, need - tot))
if tot == 0:
    print("  [D16] 旧 18610 句已删除且不迁移，这是预期的从零起点。")
