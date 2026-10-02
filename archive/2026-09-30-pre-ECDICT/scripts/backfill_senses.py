#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 Stage1 义项解析结果回填到词表 TSV 的 pos 与 senseIds 列。

- pos: 首义项的 pos；多义项且词性不同，用 "/" 连首义项与其余不同词性
- senseIds: 以 "," 连接全部 senseId（s1,s2,...）
写回 assets/wordlists/kaoyan_dagang_core.tsv 与 kaoyan_dagang_full.tsv。
"""
import csv
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SENSE_DIR = os.path.join(ROOT, "assets", "senses")
WORDS = [
    os.path.join(ROOT, "assets", "wordlists", "kaoyan_dagang_core.tsv"),
    os.path.join(ROOT, "assets", "wordlists", "kaoyan_dagang_full.tsv"),
]
_LEMMA_SAFE = re.compile(r"[^a-zA-Z0-9_.#'\-]")


def lemma_filename(lemma):
    return _LEMMA_SAFE.sub("_", lemma) + ".tsv"


def load_senses(lemma):
    path = os.path.join(SENSE_DIR, lemma_filename(lemma))
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def main():
    for wl in WORDS:
        if not os.path.exists(wl):
            continue
        rows = list(csv.DictReader(open(wl, encoding="utf-8"), delimiter="\t"))
        for row in rows:
            senses = load_senses(row["lemma"])
            if not senses:
                continue
            pos_list = [s["pos"] for s in senses if s["pos"]]
            pos = pos_list[0] if pos_list else ""
            uniq_pos = list(dict.fromkeys(p for p in pos_list if p))
            if len(uniq_pos) > 1:
                pos = "/".join(uniq_pos)
            sid = ",".join(s["senseId"] for s in senses)
            row["pos"] = pos
            row["senseIds"] = sid
        with open(wl, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=rows[0].keys(), delimiter="\t")
            w.writeheader()
            w.writerows(rows)
        print(f"updated {os.path.basename(wl)} ({len(rows)} rows)")


if __name__ == "__main__":
    main()