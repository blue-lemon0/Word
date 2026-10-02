#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将 senses/*.tsv 的旧式 senseId（n1,v2,adj1...）统一为 s1,s2,s3...。

早期 LLM 输出用 pos 首字母+序号命名 senseId，prompt 已改为 sN 后新文件用 sN。
本脚本只做文本归一，不重跑。回填脚本后需重新执行（backfill_senses.py）。
"""
import csv
import glob
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SENSE_DIR = os.path.join(ROOT, "assets", "senses")
_OLD = re.compile(r"^[a-z]+\d+$")


def main():
    changed = 0
    for path in glob.glob(os.path.join(SENSE_DIR, "*.tsv")):
        rows = list(csv.DictReader(open(path, encoding="utf-8"), delimiter="\t"))
        fixed = False
        for i, r in enumerate(rows, 1):
            sid = r.get("senseId", "")
            if _OLD.match(sid):
                r["senseId"] = f"s{i}"
                fixed = True
        if fixed:
            with open(path, "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=[k for k in rows[0].keys()], delimiter="\t")
                w.writeheader()
                w.writerows(rows)
            changed += 1
    print(f"normalized {changed} files")


if __name__ == "__main__":
    main()