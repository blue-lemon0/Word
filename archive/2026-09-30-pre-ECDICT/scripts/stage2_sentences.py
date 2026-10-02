#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 2: 例句生成。

对 Sense 目录里每个多义词的每个义项，生成 5+ 句（3 用 + 2 备用），
按词写入 assets/sentences/<lemma>.tsv。

- 逐义项调用（并行 workers）
- 每个义项单独文件？不，按词聚合：一个词一个 tsv，多列
  列: senseId, text, clue, span_start, span_len, translation, note, source
- 断点续跑：<lemma>.tsv 已存在且包含所有义项则跳过
"""
import argparse
import csv
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SENSE_DIR = os.path.join(ROOT, "assets", "senses")
SENT_DIR = os.path.join(ROOT, "assets", "sentences")
PROMPT_FILE = os.path.join(ROOT, "assets", "prompts", "stage2_sentence.md")
_LEMMA_SAFE = re.compile(r"[^a-zA-Z0-9_.#'\-]")
_print_lock = threading.Lock()


def fmt_name(lemma):
    return _LEMMA_SAFE.sub("_", lemma)


def load_prompt():
    with open(PROMPT_FILE, encoding="utf-8") as f:
        return f.read().strip()


def read_senses(lemma):
    path = os.path.join(SENSE_DIR, fmt_name(lemma) + ".tsv")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def gen_one(client, model, system, lemma, sense):
    sense_id = sense["senseId"]
    user = (
        f"单词: {lemma} ({sense.get('pos','')})\n"
        f"目标义项: {sense.get('glossZh','')} / {sense.get('glossEn','')}\n"
        f"义项标记: {'陷阱义（用户熟第1义，需特别强化）' if sense.get('trap')=='1' else '核心义'}\n\n"
        "请生成 5 个符合四约束的例句。"
    )
    data = llm_client.chat_json(client, model, system, user)
    sens = data.get("sentences", [])
    if not sens:
        raise RuntimeError("空句子")
    return sens


def write_lemma(lemma, senses_out):
    path = os.path.join(SENT_DIR, fmt_name(lemma) + ".tsv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "senseId", "text", "clue", "span_start", "span_len",
            "translation", "note", "source"], delimiter="\t")
        w.writeheader()
        w.writerows(senses_out)


def process_word(client, model, system, lemma, senses, min_per_sense, extra_retries):
    out_rows = []
    for s in senses:
        last_err = None
        for attempt in range(1 + extra_retries):
            try:
                sens = gen_one(client, model, system, lemma, s)
                for item in sens[:min_per_sense]:
                    span = item.get("highlightSpan") or [0, len(item.get("text",""))]
                    out_rows.append({
                        "senseId": s["senseId"],
                        "text": item.get("text", ""),
                        "clue": item.get("clueWord", ""),
                        "span_start": span[0],
                        "span_len": max(1, span[1] - span[0] if isinstance(span, list) else len(span)),
                        "translation": item.get("translation", ""),
                        "note": item.get("note", ""),
                        "source": "GENERATED",
                    })
                if len(out_rows) >= min_per_sense:
                    break
            except Exception as e:
                last_err = e
                continue
        else:
            if last_err:
                raise RuntimeError(f"{lemma}/{s['senseId']} 重试{extra_retries}次仍失败: {last_err}")
    return out_rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="最多处理词数")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--min-per-sense", type=int, default=5, help="每义项至少句数")
    ap.add_argument("--extra-retries", type=int, default=2)
    args = ap.parse_args()

    os.makedirs(SENT_DIR, exist_ok=True)
    system = load_prompt()

    # 收集所有词（多义与单义均可出题，D12'）
    multi = []
    all_files = sorted(f for f in os.listdir(SENSE_DIR) if f.endswith(".tsv"))
    for f in all_files:
        lemma = f[:-4]
        senses = read_senses(lemma)
        if len(senses) >= 1:
            multi.append((lemma, senses))

    # 断点续跑：已完成的词跳过
    remaining = []
    for lemma, senses in multi:
        out_path = os.path.join(SENT_DIR, fmt_name(lemma) + ".tsv")
        if os.path.exists(out_path):
            with open(out_path, encoding="utf-8") as f:
                done_senses = {r["senseId"] for r in csv.DictReader(f, delimiter="\t")}
            if all(s["senseId"] in done_senses for s in senses):
                continue
        remaining.append((lemma, senses))

    if args.limit:
        remaining = remaining[: args.limit]
    print(f"目标词 {len(multi)}，待生成 {len(remaining)}")
    if not remaining:
        return

    client, model = llm_client.get_client()
    results = []
    lock = threading.Lock()

    def work(item):
        lemma, senses = item
        try:
            rows = process_word(client, model, system, lemma, senses, args.min_per_sense, args.extra_retries)
            write_lemma(lemma, rows)
            with lock:
                print(f"OK  {lemma}\t{len(rows)} 句")
            return (lemma, True, "")
        except Exception as e:
            with lock:
                print(f"ERR {lemma}\t{e}", file=sys.stderr)
            return (lemma, False, str(e))

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for fut in as_completed([ex.submit(work, it) for it in remaining]):
            results.append(fut.result())
    ok = sum(1 for _, s, _ in results if s)
    print(f"batch done: {ok}/{len(results)} OK")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()