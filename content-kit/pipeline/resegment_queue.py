# -*- coding: utf-8 -*-
"""从 decisions 生成「待办队列」——铺开时的施工单。

## 为什么需要这个

铺到 2927 个词时，人工不可能记得「哪个词处理过、哪个超限、哪个漏了」。
本脚本把 decisions 与数据现状交叉比对，输出三类队列：

  TODO      没有 decisions 文件的词（待写义项决策）
  REVIEW    有 decisions 但产出超限/有疑似同义的词（待人工判断合并）
  AUDIT     有 decisions 但 _oldSenses 账目不完整（会静默丢义项，必须补）

`--report` 输出可直接当施工单读；`--queue <类> <数量>` 输出下一批词清单。

它只读，不写任何文件 —— 保持 content-kit 只读 source/ 与 data/wordlist/ 的边界。
"""
import argparse
import collections
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resegment as R  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")


def zh_units(word):
    return R.zh_units(word)


def _concept_overlap(en_body, zh_gloss):
    """英文释义与中文释义的「概念重合度」0..1。

    做不到真正的语义对齐（那要 LLM）。这里只做**双向词级抽取**的粗判：
    英文按空格切出实词，中文按字切出 2-gram，两边有交集即视为可能相关。

    用途只有一个：**在完全无交集时提醒人工看一眼**。
    实测样本（D27）：arrest 的 ECDICT 英文释义是心脏骤停后的停搏状态，
    而中文四义是逮捕/监禁/拘捕/抑制 —— 双向 0 重合，明显不是一回事。
    这类词是 ECDICT 数据错误，必须人工确认，规则救不了。
    """
    stop = set("a an the of to be in for on at by or as is are was were with that this "
               "it its and not no s t d".split())
    en = {w.strip(".,;:()'\"").lower() for w in en_body.split()}
    en = {w for w in en if len(w) > 2 and w not in stop}
    zh = zh_gloss.strip()
    zh_ngrams = {zh[i:i + 2] for i in range(len(zh) - 1)}
    zh_chars = set(zh)
    if not en or not zh:
        return 0.0
    hit = 0
    for w in en:
        # 英文词与中文任一 2-gram 有共同汉字，或整词出现在中文里
        if w in zh_ngrams or w in zh:
            hit += 1
        elif len(w) <= 4 and any(c in zh_chars for c in w[:2]):
            hit += 0.5
    return hit / len(en)


def classify(cfg, snap, word):
    """返回 (状态, 说明列表)。状态 ∈ done / review / audit / todo"""
    dec = R.load_decisions(cfg, word)
    if dec is None:
        return "todo", []
    kept, _ = R.english_units(word, snap, cfg)
    notes = []

    # 账目完整性
    all_zh = {i for _, _, i in zh_units(word)}
    taken = set()
    for s in dec.get("senses", []):
        taken |= set(s.get("fromZh") or [])
    ledger = {e.get("oldSenseIndex") for e in (dec.get("_oldSenses") or [])}
    missing = sorted(all_zh - taken - ledger)
    if missing:
        return "audit", ["现有义项下标 %s 既未接住也未在 _oldSenses 说明（会静默丢失）" % missing]

    # 产出条数 vs 补缺层上限
    n_out = len(dec.get("senses", []))
    soft = R.soft_cap()
    if soft and n_out > soft and not dec.get("_mergeNote"):
        notes.append("产出 %d 义项 > 上限 %d，且无 _mergeNote" % (n_out, soft))

    # 用户分不开的产出义项对（D30）。
    # 只比**产出义项**，不比全部边界 —— 之前用 separability_flags 比边界，
    # 于是「已合并成一条义项的两个边界」被报成疑似同义，6 个 review 里
    # 有 3 个是这种纯噪音（affect/argue/agent），真正的待办被稀释了。
    by_raw = {R._raw_key(u["raw"]): u for u in kept}
    for i, j, ej, zj, za, zb in R.confusable_pairs(cfg, dec, by_raw):
        notes.append("产出义项可能分不开 s%d/s%d (en=%.2f zh=%.2f): %s || %s"
                     % (i, j, ej, zj, za, zb))

    # ── 英文释义与中文义项可能完全无关（D27）──────────────
    # ECDICT 偶尔导出**罕见**义位、漏掉全部常用义：
    #   arrest  ECDICT definition = 'n. the state of inactivity following an interruption'
    #           现有中文 4 义 = 逮捕/监禁/拘捕/抑制  ← 双向 0 重合
    # WordNet 里 arrest 只有这一条首词义位，「逮捕」分散在 collar.v.01 /
    # check.v.18 / halt.v.01 三个别的词的 synset 下 —— 放宽到 lemma 匹配能救，
    # 但实测让义位总数暴涨 54%（find 6→18、cut 54→70），同义词污染全回来了。
    #
    # 所以这类词只能人工确认。这里只做「双向 0 重合」的提醒，不做判定。
    old = zh_units(word)
    if old and kept:
        best = 0.0
        pair = None
        for u in kept:
            for _, zh, _ in old:
                ov = _concept_overlap(u["body"], zh)
                if ov > best:
                    best, pair = ov, (u["body"], zh)
        if pair and best == 0.0:
            notes.append("英文释义与所有中文义项零重合，请确认是否同一概念："
                         "EN=%s / 最近的中文=%s" % (pair[0][:46], pair[1]))

    if notes:
        return "review", notes
    return "done", []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="输出各队列概况")
    ap.add_argument("--queue", nargs=2, metavar=("KIND", "N"),
                    help="取某类队列的前 N 个词")
    a = ap.parse_args()
    cfg = R.load_spec()
    snap = R.load_snapshot(cfg)
    skip_set = R.active_skip(cfg)

    state = {}
    reasons = collections.defaultdict(list)
    for word, _ in R.load_core():
        if word in skip_set:
            continue
        s, notes = classify(cfg, snap, word)
        state[word] = s
        if notes:
            reasons[word] = notes

    if a.queue:
        kind, n = a.queue[0], int(a.queue[1])
        pick = [w for w, s in state.items() if s == kind][:n]
        print("\n".join(pick))
        return

    print("=" * 70)
    print("decisions 队列状况（%d 词）" % len(state))
    print("=" * 70)
    c = collections.Counter(state.values())
    for k, v in c.most_common():
        print("   %-8s %5d 词" % (k, v))

    # 边界数超限的词（即使还没写 decisions，也要提前知道）
    heavy = []
    for word, _ in R.load_core():
        if word in skip_set:
            continue
        kept, _ = R.english_units(word, snap, cfg)
        if len(kept) > (R.soft_cap() or 10 ** 9):
            heavy.append((word, len(kept)))
    heavy.sort(key=lambda x: -x[1])
    print("\n英文边界数 > %s 的词: %d" % (R.soft_cap(), len(heavy)))
    print("   最极端 20 个: %s" % ", ".join("%s(%d)" % h for h in heavy[:20]))

    for kind in ("audit", "review"):
        sel = [w for w, s in state.items() if s == kind]
        if not sel:
            continue
        print("\n--- %s (%d 词) ---" % (kind.upper(), len(sel)))
        for w in sel[:12]:
            print("   %-12s %s" % (w, "; ".join(reasons[w])))
        if len(sel) > 12:
            print("   ... 还有 %d 个" % (len(sel) - 12))


if __name__ == "__main__":
    main()