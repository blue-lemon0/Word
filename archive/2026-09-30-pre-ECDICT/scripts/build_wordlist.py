#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 0: 词表输入 -> kaoyan_dagang_core.tsv / kaoyan_dagang_full.tsv

数据源: exam-data/NETEMVocabulary (netem_full_list.json)
输出:
  assets/wordlists/kaoyan_dagang_core.tsv   # 核心 3000（实义，CORE）
  assets/wordlists/kaoyan_dagang_full.tsv   # 全量 5530（含 CORE 标记）
  assets/wordlists/filtered_function_words.tsv  # 被剔除的功能词，供人工 review
"""
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "wordlists", "source_netem_full_list.json")
CORE_TSV = os.path.join(ROOT, "assets", "wordlists", "kaoyan_dagang_core.tsv")
FULL_TSV = os.path.join(ROOT, "assets", "wordlists", "kaoyan_dagang_full.tsv")
FILTERED_TSV = os.path.join(ROOT, "assets", "wordlists", "filtered_function_words.tsv")

CORE_TARGET = 3000

# 功能词子分类：无义项分叉，不适合单义判别
FUNCTION_SUBCATS = {"基础功能词", "逻辑与关系", "代词"}

# 显式功能词黑名单（作者子分类有漏网）。
# 依据：无实质义项分叉（代词/冠词/介词/连词/助动词/be 动词/情态），
# 或实义性极低，做"单义判别"无区分度。
# 注意：兼类词（如 can/n.容器, will/n.意志）不在此列，由义项生成阶段另行处理。
OVERRIDES_TSV = os.path.join(ROOT, "assets", "wordlists", "semantic_overrides.tsv")

FUNCTION_LEMMAS = {
    # 代词
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
    "them", "my", "your", "his", "its", "our", "their", "mine", "yours",
    "myself", "yourself", "himself", "herself", "itself", "ourselves",
    "yourselves", "themselves", "one", "ones", "someone", "something",
    "anyone", "anything", "everyone", "everything", "nothing", "nobody",
    "somebody", "anybody", "everybody", "each", "either", "neither", "both",
    "all", "some", "any", "other", "others", "another", "many", "much",
    "few", "several", "most", "such", "own", "who", "whom", "whose",
    "what", "which", "whatever", "whoever",
    # 冠词
    "a", "an", "the",
    # be / 助动词 / 情态
    "be", "am", "is", "are", "was", "were", "been", "being", "do", "does",
    "did", "done", "have", "has", "had", "having", "may", "might", "must",
    "shall", "should", "will", "would", "can", "could", "ought to",
    # 介词 / 连词
    "to", "in", "on", "at", "with", "by", "for", "of", "from", "about",
    "over", "under", "above", "below", "between", "among", "through",
    "across", "along", "around", "after", "before", "during", "into",
    "onto", "upon", "within", "without", "toward", "towards", "against",
    "off", "up", "down", "out", "via", "and", "but", "or", "so", "nor",
    "if", "than", "that", "this", "these", "those", "as", "not", "just",
    "how", "why", "because", "even", "also", "however", "whether", "though",
    "although", "instead", "together", "except", "therefore", "thus", "else",
    "despite", "unless", "neither", "unlike", "otherwise", "moreover",
    "regardless", "nevertheless", "whereas", "besides", "plus", "anyway",
    "hence", "somehow", "consequently", "lest", "nonetheless", "likewise",
    "thereby", "versus", "accordingly", "whichever", "incidentally", "whereby",
    "conversely", "namely", "irrespective", "whatsoever", "anyhow",
    "notwithstanding", "according to", "albeit", "owing to", "provided",
    "regarding",
}

FIELDS = ["lemma", "pos", "tier", "senseIds", "freq", "gloss", "alt", "category", "subcategory"]


def load():
    with open(SRC, encoding="utf-8") as f:
        data = json.load(f)
    key = next(iter(data))  # "5530考研词汇词频排序表"
    return data[key]


def load_overrides():
    """读取 semantic_overrides.tsv：KEEP 从功能词剔除集中移除；EXCLUDE 强制加入。"""
    keep, exclude = set(), set()
    if not os.path.exists(OVERRIDES_TSV):
        return keep, exclude
    with open(OVERRIDES_TSV, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            lemma, action = parts[0].strip().lower(), parts[1].strip().upper()
            if action == "KEEP":
                keep.add(lemma)
            elif action == "EXCLUDE":
                exclude.add(lemma)
    return keep, exclude


def main():
    keep_override, exclude_override = load_overrides()
    raw = load()
    rows = []
    for w in raw:
        sub = w.get("子分类") or ""
        rows.append({
            "lemma": (w["单词"] or "").strip(),
            "pos": "",
            "tier": "FULL",
            "senseIds": "",
            "freq": int(w.get("词频") or 0),
            "gloss": (w.get("释义") or "").strip(),
            "alt": (w.get("其他拼写") or "").strip(),
            "category": (w.get("分类") or "").strip(),
            "subcategory": sub,
        })

    # 按词频降序（同频保序）
    rows.sort(key=lambda r: (-r["freq"], r["lemma"]))

    def is_functional(r):
        return (r["subcategory"] in FUNCTION_SUBCATS
                or r["lemma"].lower() in FUNCTION_LEMMAS
                or r["lemma"].lower() in exclude_override)

    func = [r for r in rows if is_functional(r) and r["lemma"].lower() not in keep_override]
    content = [r for r in rows if not is_functional(r) or r["lemma"].lower() in keep_override]

    # 核心 = 实义词按词频降序取前 3000
    core = content[:CORE_TARGET]
    core_ids = {r["lemma"] for r in core}
    for r in rows:
        if r["lemma"] in core_ids:
            r["tier"] = "CORE"

    write_tsv(FULL_TSV, rows)
    write_tsv(CORE_TSV, core)
    write_tsv(FILTERED_TSV, func)

    print(f"source total : {len(rows)}")
    print(f"function-only: {len(func)}")
    print(f"core (CORE)  : {len(core)}  (contains freq>=40: {sum(1 for r in core if r['freq']>=40)})")
    print(f"core freq min: {min(r['freq'] for r in core)}")
    print(f"full (FULL)  : {len(rows) - len(func)}  (core mapped to FULL file)")
    print(f"freq==0 kept : {sum(1 for r in rows if r['freq']==0)}")
    print("--- filtered function words ---")
    for r in func:
        print(f"  {r['lemma']}\t{r['freq']}\t{r['subcategory']}")


def write_tsv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, delimiter="\t")
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()