#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""进度跟踪：扫描 senses/ 与 sentences/ 对比完成度。

用于任何批处理完成后快速确认，不依赖运行日志（日志是缓冲的，磁盘才是真相）。
输出：
- 总词数 / 已完成 / 待生成
- 每个 word: 生成句数 vs 应有句数（min 阈值）
- LOW_FLAG: 句子不足的词
"""
import argparse
import csv
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SENSE_DIR = os.path.join(ROOT, "assets", "senses")
SENT_DIR = os.path.join(ROOT, "assets", "sentences")
_LEMMA_SAFE = None
import re as _re
_LEMMA_SAFE = _re.compile(r"[^a-zA-Z0-9_.#'\-]")


def fmt_name(lemma):
    return _LEMMA_SAFE.sub("_", lemma)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="列出每个词的句数和状态")
    ap.add_argument("--min", type=int, default=5, help="每义项最低句数告警阈值")
    args = ap.parse_args()

    senses = {}
    for f in sorted(os.listdir(SENSE_DIR)):
        if not f.endswith(".tsv"):
            continue
        lemma = f[:-4]
        with open(os.path.join(SENSE_DIR, f), encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter="\t"))
        senses[lemma] = len(rows)

    done = {}  # lemma -> total sentence rows
    for f in sorted(os.listdir(SENT_DIR)):
        if not f.endswith(".tsv"):
            continue
        lemma = f[:-4]
        with open(os.path.join(SENT_DIR, f), encoding="utf-8") as fh:
            done[lemma] = sum(1 for _ in csv.DictReader(fh, delimiter="\t"))

    total = len(senses)
    ok = sum(1 for l in senses if l in done)
    pending = [l for l in senses if l not in done]
    low = find_low(senses, done, args.min)

    print(f"词表   : {total}")
    print(f"已完成 : {ok}")
    print(f"待生成 : {len(pending)}  {pending[:8]}{'...' if len(pending)>8 else ''}")
    print(f"句数不足: {len(low)}")
    for l in low:
        print(f"   {l}: 义项{senses[l]} 应有{args.min*senses[l]}句 实际{done.get(l,0)}")

    if args.show:
        print("\n--- 全部 ---")
        for l in sorted(senses):
            mark = "✓" if l in done else "✗"
            n = done.get(l, 0)
            flag = "" if l in done and n >= args.min * senses[l] else "  <LOW>"
            print(f"  {mark} {l:30s} {n:4d} 句 (义项{senses[l]}){flag}")


def find_low(senses, done, min_per_sense):
    out = []
    for l, n_sense in senses.items():
        n = done.get(l, 0)
        if n < min_per_sense * n_sense:
            out.append(l)
    return sorted(out)


if __name__ == "__main__":
    main()