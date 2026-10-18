# -*- coding: utf-8 -*-
"""构建 **v2** 内容包：按英文释义重切后的义项表 + 已产出的例句。

与 build_bundle.py 的关系
------------------------
build_bundle.py 读 data/wordlist/senses/（旧切分），**保留不动** ——
它是已发布内容的真相源，且被 930 句现有例句按 senseId 引用。

本脚本读 data/senses_v2/（新切分，见 docs/decisions/D18–D25）。
两者的区别：
  - 义项边界来自 Princeton WordNet 3.0 的 synset，逐义项成行
  - glossEn 全部有值（旧库 7884 条全空）
  - pos 从英文行首标记取，s.→a. / r.→adv.
  - 没有「每词最多 N 个义项」的截断（旧库那个上限是防御过度切分的产物）

产物写到 build/bundle/cards_v2.json，**不覆盖 cards.json**。
app 默认仍读 cards.json；要切到 v2 由你决定何时改指向。

用法
----
    python content-kit/pipeline/build_bundle_v2.py            # 出 v2 包
    python content-kit/pipeline/build_bundle_v2.py --stats    # 只看统计不写文件
"""
import argparse
import collections
import csv
import hashlib
import io
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(KIT)
V2_SE = os.path.join(KIT, "data", "senses_v2")          # 新义项
S = os.path.join(KIT, "data", "sentences")             # 例句（与旧库共用）
IPA_TSV = os.path.join(KIT, "data", "wordlist", "ipa.tsv")
OUT = os.path.join(REPO, "build", "bundle", "cards_v2.json")


def load_ipa():
    """word\tbyPos\tipa —— 音标按词性取，同 build_bundle.py。

    data/senses_v2 的 pos 是 n./v./a./adv.，与 ipa.tsv 的 byPos 键同形。
    """
    if not os.path.exists(IPA_TSV):
        return {}
    out = {}
    with open(IPA_TSV, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            by_pos = {}
            for kv in (r.get("byPos") or "").split():
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    by_pos[k.strip(".")] = v
            out[r["lemma"]] = {"byPos": by_pos, "ipa": r.get("ipa", "")}
    return out


def ipa_of(tbl, lemma, pos):
    e = tbl.get(lemma)
    if not e:
        return ""
    return e["byPos"].get((pos or "").strip(".").lower()) or e["ipa"] or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stats", action="store_true", help="只打印统计，不写文件")
    ap.add_argument("--out", help="输出路径（默认 build/bundle/cards_v2.json）")
    a = ap.parse_args()
    out_path = a.out or OUT

    if not os.path.isdir(V2_SE):
        print("data/senses_v2/ 不存在 —— 先跑 resegment.py --build")
        return 1

    ipa_tbl = load_ipa()
    cards = []
    gloss_pool = []
    gloss_seen = set()
    n_sent = 0
    n_no_sent = 0
    n_words = 0
    n_en = 0
    words_with_sent = set()

    for f in sorted(os.listdir(V2_SE)):
        if not f.endswith(".tsv"):
            continue
        lemma = f[:-4]
        with open(os.path.join(V2_SE, f), encoding="utf-8") as fh:
            senses = list(csv.DictReader(fh, delimiter="\t"))
        if not senses:
            continue
        n_words += 1

        rows_by = collections.defaultdict(list)
        spath = os.path.join(S, f"{lemma}.tsv")
        # ⚠️ 绝不按 senseId 直接挂旧句（D26）。
        # 旧句的 senseId 是按**旧义项顺序**编号的，而 v2 的义项顺序变了：
        #   queen  旧 s1=王后  →  v2 s1=蜂后（蜂后是 WordNet 新增的首条边界）
        #   army   旧 s2=陆军  →  v2 s2=大批人；大军
        #   edition 旧 s3=翻版  →  v2 s3=报纸的一次发行
        # 直接挂的后果：界面上「蜂后」配「战前国王与王后交谈」—— 教错义项。
        #
        # 所以：**只接受与 v2 义项完全对齐的例句文件**。判定方式是文件名后缀，
        # 由造句流程在产出时打标（见 resegment 的句子流程）：
        #   sentences/<word>.tsv          旧的，不能用
        #   data/sentences_v2/<word>.tsv  新切分专用的，可用
        # 现在后者还不存在，所以下面这一段恒为空 —— v2 包会如实显示 0 句，
        # 而不是拿错位的旧句凑数。
        v2_sent = os.path.join(KIT, "data", "sentences_v2", f"{lemma}.tsv")
        if os.path.exists(v2_sent):
            with open(v2_sent, encoding="utf-8") as fh:
                for r in csv.DictReader(fh, delimiter="\t"):
                    rows_by[r["senseId"]].append(r)
            words_with_sent.add(lemma)

        for s in senses:
            sid = s["senseId"]
            rs = rows_by.get(sid, [])
            zh = (s.get("glossZh") or "").strip()
            en = (s.get("glossEn") or "").strip()
            if zh and zh not in gloss_seen:
                gloss_seen.add(zh)
                gloss_pool.append(zh)
            if en:
                n_en += 1
            if not rs:
                n_no_sent += 1
            n_sent += len(rs)
            cards.append({
                "id": "%s#%s" % (lemma, sid),
                "word": lemma, "senseId": sid,
                "pos": s.get("pos", ""),
                "ipa": ipa_of(ipa_tbl, lemma, s.get("pos", "")),
                "gloss": zh,
                "glossEn": en,
                "trap": 1 if s.get("trap") == "1" else 0,
                "tier": s.get("tier", ""),
                "sentences": [{
                    "text": r["text"],
                    "form": r["text"][int(r.get("span_start") or 0):
                                   int(r.get("span_start") or 0)
                                   + int(r.get("span_len") or 0)],
                    "clue": r.get("clue", ""),
                    "spanStart": int(r.get("span_start") or 0),
                    "spanLen": int(r.get("span_len") or 0),
                    "translation": r.get("translation", ""),
                    "note": r.get("note", ""),
                    "source": r.get("source", ""),
                } for r in rs],
            })

    # version 哈希必须含 glossEn/pos，否则改了英文释义 syncBundle 会跳过重建
    # （见 build_bundle.py 同处注释 与 docs/decisions/D19）
    h = hashlib.sha1()
    for c in cards:
        h.update(("%s\x1f%s\x1f%d\x1f%s\x1f%s\x1f%s\x1f%s\x1e" % (
            c["word"], c["senseId"], len(c["sentences"]), c["gloss"],
            c["glossEn"], c["pos"], c["trap"])).encode("utf-8"))
        for r in c["sentences"]:
            h.update(("%s\x1f%s\x1e" % (r["text"], r["clue"])).encode("utf-8"))
    version = "%s-%s" % (time.strftime("%Y%m%d"), h.hexdigest()[:8])

    st = {
        "words": n_words, "senses": len(cards), "cards": len(cards),
        "withSentences": len(cards) - n_no_sent, "sentences": n_sent,
        "glossPool": len(gloss_pool), "withGlossEn": n_en,
        "noSentence": n_no_sent,
        "mode": "FULL" if n_no_sent == 0 else "SENSES_ONLY" if n_sent == 0 else "PARTIAL",
    }
    print("=" * 62)
    print("v2 内容包  version=%s" % version)
    print("=" * 62)
    print("  词数          :", st["words"])
    print("  义项(卡片)    :", st["cards"])
    print("  有英文释义    : %d (%.1f%%)" % (n_en, n_en / max(1, len(cards)) * 100))
    print("  有句义项      : %d  (涉及 %d 词)" % (st["withSentences"], len(words_with_sent)))
    print("  无句义项      :", st["noSentence"])
    print("  例句总数      :", st["sentences"])
    print("  mode          :", st["mode"])
    d = collections.Counter(len(c["sentences"]) for c in cards)
    print("  每卡句数分布  :", dict(sorted(d.items())))
    if a.stats:
        print("\n[--stats] 未写文件")
        return 0
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"format": "word-bundle", "schemaVersion": 1,
                   "version": version, "stats": st,
                   "glossPool": gloss_pool, "cards": cards},
                  fh, ensure_ascii=False, separators=(",", ":"))
    print("\n  -> %s  (%.3f MB)"
          % (out_path, os.path.getsize(out_path) / 1024 / 1024))
    print("\n注意：cards.json 未改动，app 仍读旧包。要切到 v2 由你决定。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
