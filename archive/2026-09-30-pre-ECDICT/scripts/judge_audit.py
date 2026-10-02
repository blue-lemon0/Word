# -*- coding: utf-8 -*-
"""质检后可用句量统计：按义项看 PASS 句数分布，标出不足的。"""
import csv, os, sys, collections
sys.stdout.reconfigure(encoding="utf-8")

SENSE = r"D:\projectX\android\Word\assets\senses"
JUDGE = r"D:\projectX\android\Word\assets\judge_results"

per_sense = {}   # (lemma, senseId) -> pass_count
for f in os.listdir(JUDGE):
    if not f.endswith(".tsv"):
        continue
    lemma = f[:-4]
    for r in csv.DictReader(open(os.path.join(JUDGE, f), encoding="utf-8"), delimiter="\t"):
        if r["passed"] == "PASS":
            per_sense[(lemma, r["senseId"])] = per_sense.get((lemma, r["senseId"]), 0) + 1

sense_count = {}  # (lemma, senseId) -> 1
for f in os.listdir(SENSE):
    if not f.endswith(".tsv"):
        continue
    lemma = f[:-4]
    for r in csv.DictReader(open(os.path.join(SENSE, f), encoding="utf-8"), delimiter="\t"):
        sense_count[(lemma, r["senseId"])] = 1

dist = collections.Counter(per_sense.get(k, 0) for k in sense_count)
print("义项总数:", len(sense_count))
print("可用 PASS 句数分布:")
for n in sorted(dist):
    tag = ""
    if n == 0: tag = "  <-- 全灭"
    elif n == 1: tag = "  <-- 仅1句(勉强)"
    elif n == 2: tag = "  <-- 偏少"
    print(f"  {n} 句: {dist[n]} 个义项{tag}")

bad = [k for k in sense_count if per_sense.get(k, 0) == 0]
low = [k for k in sense_count if 0 < per_sense.get(k, 0) <= 2]
print(f"\n全灭义项: {len(bad)}")
for k in bad[:15]:
    print("   ", k[0], k[1])
print(f"\n<=2句义项: {len(low)}")
for k in low[:15]:
    print("   ", k[0], k[1], per_sense[k], "句")