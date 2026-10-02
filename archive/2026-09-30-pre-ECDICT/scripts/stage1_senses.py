#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 1: 义项解析。

读取 assets/wordlists/kaoyan_dagang_core.tsv（也可选 full），对每个词调用
LLM 解析出结构化义项列表，写入 assets/senses/<lemma>.tsv。

设计：
- key 从环境变量 / scripts/.llm_key 读（见 llm_client.py）
- 逐词调用（noun 调用慢，但义项解析对上下文敏感，不整批）
- 失败词写入 assets/senses/_failed.tsv，不中断全场
- 可打断重跑：已有输出的词跳过（--force 可重做）
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
WORDLIST = os.path.join(ROOT, "assets", "wordlists", "kaoyan_dagang_core.tsv")
SENSE_DIR = os.path.join(ROOT, "assets", "senses")
FAILED = os.path.join(SENSE_DIR, "_failed.tsv")
PROMPT_FILE = os.path.join(ROOT, "assets", "prompts", "stage1_senses.md")

SENSE_FIELDS = ["senseId", "pos", "glossZh", "glossEn", "trap", "note"]
# 词条名可能含反斜杠/空格等，用于敏感字符清洗
_LEMMA_SAFE = re.compile(r"[^a-zA-Z0-9_.#'\-]")
_print_lock = threading.Lock()
_fail_lock = threading.Lock()


def load_prompt():
    with open(PROMPT_FILE, encoding="utf-8") as f:
        return f.read().strip()


def lemma_filename(lemma):
    return _LEMMA_SAFE.sub("_", lemma) + ".tsv"


def senses_done():
    if not os.path.isdir(SENSE_DIR):
        return set()
    return {f for f in os.listdir(SENSE_DIR) if f.endswith(".tsv") and f != "_failed.tsv"}


def parse_one(client, model, system, lemma, gloss):
    user = f"单词: {lemma}\n大纲释义: {gloss}\n\n请解析义项。"
    data = llm_client.chat_json(client, model, system, user)
    senses = data.get("senses", [])
    out = []
    for i, s in enumerate(senses, 1):
        out.append({
            "senseId": s.get("senseId") or f"v{i}",
            "pos": s.get("pos", ""),
            "glossZh": s.get("glossZh", ""),
            "glossEn": s.get("glossEn", ""),
            "trap": "1" if s.get("trap") else "0",
            "note": s.get("note", ""),
        })
    return out


def write_sense(lemma, senses):
    path = os.path.join(SENSE_DIR, lemma_filename(lemma))
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SENSE_FIELDS, delimiter="\t")
        w.writeheader()
        w.writerows(senses)


def record_failed(lemma, gloss, reason):
    with open(FAILED, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t")
        if f.tell() == 0:
            w.writerow(["lemma", "gloss", "reason"])
        w.writerow([lemma, gloss, reason])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10, help="处理词数上限(默认10,便于试跑)")
    ap.add_argument("--force", action="store_true", help="忽略已生成的，强行重跑")
    ap.add_argument("--workers", type=int, default=4, help="并发请求数(默认4,DeepSeek 限速友好)")
    ap.add_argument("--wordlist", default=WORDLIST)
    args = ap.parse_args()

    if not os.path.exists(FAILED):
        open(FAILED, "w", encoding="utf-8").close()
    os.makedirs(SENSE_DIR, exist_ok=True)

    with open(args.wordlist, encoding="utf-8") as f:
        words = [r for r in csv.DictReader(f, delimiter="\t")]

    done = set() if args.force else senses_done()
    todo = [w for w in words if lemma_filename(w["lemma"]) not in done]
    todo = todo[: args.limit]

    if not todo:
        print("无待处理词。")
        return

    system = load_prompt()
    client, model = llm_client.get_client()

    def process(w):
        lemma = w["lemma"]
        gloss = w["gloss"]
        try:
            senses = parse_one(client, model, system, lemma, gloss)
            if not senses:
                raise RuntimeError("空义项")
            write_sense(lemma, senses)
            ok = f"OK  {lemma}\t{len(senses)} 义项\t{gloss}"
            with _print_lock:
                print(ok)
            return (lemma, True, "")
        except Exception as e:
            with _print_lock:
                print(f"ERR {lemma}\t{e}", file=sys.stderr)
            with _fail_lock:
                record_failed(lemma, gloss, str(e))
            return (lemma, False, str(e))

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for _ in as_completed([ex.submit(process, w) for w in todo]):
            pass
    print("batch done")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()