#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 3: 独立质检。

对 assets/sentences/*.tsv 里的每一句，调用 judge LLM（stage3_judge.md）
逐句判 PASS / REJECT。输出：
- 每词一个 results/<lemma>.tsv：senseId, text, passed, reason, source
- 汇总报告 REJECT 率（>5% 才算质检器有在用）
- 被判 REJECT 的行追加进 user_flags.jsonl（Stage 2 输入侧优先重生成）

说明：
- judge prompt 与生成 prompt 完全解耦（只看成品 + 规格）。
- 批量调用：一次发一个词的全部句子，judge 用 index 映射回。
- 断点续跑：results/<lemma>.tsv 已存在且配套则跳过。
"""
import argparse
import csv
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_client

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SENT_DIR = os.path.join(ROOT, "assets", "sentences")
SENSE_DIR = os.path.join(ROOT, "assets", "senses")
RESULT_DIR = os.path.join(ROOT, "assets", "judge_results")
FLAGS_FILE = os.path.join(ROOT, "assets", "user_flags.jsonl")
PROMPT_FILE = os.path.join(ROOT, "assets", "prompts", "stage3_judge.md")
_LEMMA_SAFE = re.compile(r"[^a-zA-Z0-9_.#'\-]")
_print_lock = threading.Lock()


def fmt_name(lemma):
    return _LEMMA_SAFE.sub("_", lemma)


def load_prompt():
    with open(PROMPT_FILE, encoding="utf-8") as f:
        return f.read().strip()


def read_lemma_sentences(lemma):
    path = os.path.join(SENT_DIR, fmt_name(lemma) + ".tsv")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def read_sense_map(lemma):
    path = os.path.join(SENSE_DIR, fmt_name(lemma) + ".tsv")
    m = {}
    if not os.path.exists(path):
        return m
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            m[r["senseId"]] = r
    return m


def build_batch(lemma, rows, sense_map):
    """词级批量：一prompt判整词全部句子。"""
    items = []
    for i, r in enumerate(rows):
        s = sense_map.get(r.get("senseId", ""), {})
        items.append({
            "index": i,
            "word": lemma,
            "pos": s.get("pos", r.get("pos", "")),
            "targetSense": {
                "senseId": s.get("senseId", r.get("senseId", "")),
                "glossZh": s.get("glossZh", ""),
                "glossEn": s.get("glossEn", ""),
                "trap": s.get("trap", "0"),
            },
            "sentence": {
                "text": r.get("text", ""),
                "translation": r.get("translation", ""),
                "note": r.get("note", ""),
            },
        })
    return items


def judge_batch(client, model, system, lemma, items):
    payload = {"target": lemma, "cases": items}
    user = json.dumps(payload, ensure_ascii=False)
    data = llm_client.chat_json(client, model, system, user)
    verdicts = data.get("verdicts", [])
    if not verdicts:
        raise RuntimeError("空判定")
    return verdicts


def write_results(lemma, rows, verdicts_by_index):
    """写 results/<lemma>.tsv，行序与原 sentences 一致。

    本地机械校验补位：句长 G2（8-12 词）不交给 LLM。
    judge 只判语义（词形/线索/译文/超纲）；此处句长硬判，
    超范围直接 REJECT（即使 LLM 给了 PASS）。
    """
    os.makedirs(RESULT_DIR, exist_ok=True)
    path = os.path.join(RESULT_DIR, fmt_name(lemma) + ".tsv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "senseId", "text", "passed", "reason", "source"], delimiter="\t")
        w.writeheader()
        for i, r in enumerate(rows):
            v = verdicts_by_index.get(i, {})
            word_count = len(r.get("text", "").split())
            passed = v.get("result") == "PASS" and 7 <= word_count <= 12
            reason = v.get("reason", "")
            if passed is False and v.get("result") == "PASS":
                reason = f"[G2 句长 {word_count} 词，超出 7-12] " + reason
            w.writerow({
                "senseId": r.get("senseId", ""),
                "text": r.get("text", ""),
                "passed": "PASS" if passed else "REJECT",
                "reason": reason,
                "source": r.get("source", "GENERATED"),
            })


def append_flags(lemma, rows, verdicts_by_index):
    """REJECT 的行追加进 user_flags.jsonl（供 Stage 2 优先重生成）。

    判定对齐 write_results：LLM result + 本地句长硬判。
    """
    rejects = []
    for i, r in enumerate(rows):
        v = verdicts_by_index.get(i, {})
        word_count = len(r.get("text", "").split())
        passed = v.get("result") == "PASS" and 7 <= word_count <= 12
        if not passed:
            rejects.append({
                "lemma": lemma,
                "senseId": r.get("senseId", ""),
                "text": r.get("text", ""),
                "reason": v.get("reason", "") or "[G2 句长] " + str(word_count),
                "source": r.get("source", "GENERATED"),
            })
    if not rejects:
        return
    os.makedirs(os.path.dirname(FLAGS_FILE), exist_ok=True)
    with open(FLAGS_FILE, "a", encoding="utf-8") as f:
        for r in rejects:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    system = load_prompt()

    files = sorted(f for f in os.listdir(SENT_DIR) if f.endswith(".tsv"))
    pending = []
    for f in files:
        lemma = f[:-4]
        out_path = os.path.join(RESULT_DIR, fmt_name(lemma) + ".tsv")
        if os.path.exists(out_path):
            continue
        pending.append(lemma)

    if args.limit:
        pending = pending[: args.limit]
    print(f"待质检词数: {len(pending)} / {len(files)}", flush=True)
    if not pending:
        return

    client, model = llm_client.get_client()
    results = []
    lock = threading.Lock()

    def work(lemma):
        try:
            rows = read_lemma_sentences(lemma)
            sense_map = read_sense_map(lemma)
            items = build_batch(lemma, rows, sense_map)
            verdicts = judge_batch(client, model, system, lemma, items)
            by_idx = {v.get("index"): v for v in verdicts}
            # 校验全部行有判定
            for i in range(len(rows)):
                if i not in by_idx:
                    raise RuntimeError(f"missing verdict {i}")
            write_results(lemma, rows, by_idx)
            append_flags(lemma, rows, by_idx)
            n_pass = sum(1 for i in range(len(rows))
                         if by_idx.get(i, {}).get("result") == "PASS"
                         and 7 <= len(rows[i].get("text", "").split()) <= 12)
            n_reject = len(rows) - n_pass
            with lock:
                print(f"{lemma}\t{n_pass}/{len(rows)} PASS\t{n_reject} REJECT", flush=True)
            return (lemma, True, n_pass, n_reject)
        except Exception as e:
            with lock:
                print(f"ERR {lemma}\t{e}", flush=True)
            return (lemma, False, 0, 0)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for fut in as_completed([ex.submit(work, l) for l in pending]):
            results.append(fut.result())

    ok = [r for r in results if r[1]]
    total_pass = sum(r[2] for r in ok)
    total_reject = sum(r[3] for r in ok)
    total = total_pass + total_reject
    rate = total_reject / total if total else 0
    print(f"batch done: {len(ok)}/{len(results)} OK")
    print(f"PASS {total_pass}  REJECT {total_reject}  质检 REJECT 率 {rate:.1%}")
    print("（规格 §5.3：REJECT 率应 > 5%，太低说明质检器在放水）")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()