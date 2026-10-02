# -*- coding: utf-8 -*-
"""B 方案 -> assets/senses/（正式词库）。

D16 之前，这个脚本输出到 senses_b/ 并与旧库交叉验证，
为"要不要迁移"提供决策依据。
D16 已决定**不迁移**，因此现在的职责只剩一个：**写出正式词库**。
与旧库的对比保留为信息性输出（读归档快照，不参与任何迁移）。

输出 assets/senses/<word>.tsv：
    senseId \t pos \t glossZh \t glossEn \t trap \t note
    s1        n.      飞机场      (空)      0     tier=T1
"""
import csv, io, json, os, re, sys, collections

sys.stdout.reconfigure(encoding="utf-8")
PROJ = r"D:\projectX\android\Word"
B = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_b.json")
SDIR = os.path.join(PROJ, "assets", "senses")
ARCHIVE = os.path.join(PROJ, "archive", "2026-09-30-pre-ECDICT",
                       "old-senses", "TRAP_AND_GLOSSEN.tsv")

POS_CN = {"n": "n.", "v": "v.", "vt": "vt.", "vi": "vi.", "a": "a.", "ad": "a.",
          "adv": "adv.", "prep": "prep.", "conj": "conj.", "pron": "pron.",
          "num": "num.", "int": "int.", "interj": "int.", "aux": "aux.v.",
          "abbr": "abbr.", "art": "art.", "pref": "pref.", "adj": "a."}


def norm(s):
    """归一化释义用于比对：去标点空白"""
    return re.sub(r"[\s，,。、；;：:（）()\[\]【】/／·\-—…\.]+", "", s or "")


def main():
    sel = json.load(io.open(B, encoding="utf-8"))

    os.makedirs(SDIR, exist_ok=True)
    for f in os.listdir(SDIR):                 # 清空，保证与 json 严格一致
        os.remove(os.path.join(SDIR, f))

    # 写新 tsv
    npos_blank = 0
    for w, v in sel.items():
        with io.open(os.path.join(SDIR, w + ".tsv"), "w", encoding="utf-8", newline="") as fh:
            fh.write("senseId\tpos\tglossZh\tglossEn\ttrap\tnote\n")
            for i, s in enumerate(v["senses"], 1):
                pos = POS_CN.get(s["pos"], s["pos"] or "")
                if not pos:
                    npos_blank += 1
                fh.write("s%d\t%s\t%s\t\t0\t%s\n"
                         % (i, pos, s["zh"], "tier=%s" % v["tier"]))

    n_sense = sum(len(v["senses"]) for v in sel.values())
    print("写出 assets/senses/: %d 词 / %d 义项" % (len(sel), n_sense))
    print("词性为空的义项: %d  %s"
          % (npos_blank, "(OK, fix_pos.py 已补齐)" if npos_blank == 0 else "<-- 需检查"))

    # 与归档旧库的对比：**仅供信息参考，不用于迁移**（D16）
    if not os.path.exists(ARCHIVE):
        return
    kept = drop = 0
    old_by_word = collections.defaultdict(list)
    for i, ln in enumerate(io.open(ARCHIVE, encoding="utf-8")):
        if i == 0:
            continue
        c = ln.rstrip("\n").split("\t")
        old_by_word[c[0]].append(c)

    for w, v in sel.items():
        newgl = {norm(s["zh"]) for s in v["senses"]}
        for c in old_by_word.get(w, ()):
            g = norm(c[3])
            if not g:
                continue
            if g in newgl:
                kept += 1
            else:
                drop += 1
    print("\n[参考] 归档旧库义项 %d 条, 其中释义在新库也存在 %d 条 (%.1f%%)"
          % (kept + drop, kept, kept / max(1, kept + drop) * 100))
    print("       D16 已决定不迁移——senseId 全变，SRS 进度无法继承。")


if __name__ == "__main__":
    main()
