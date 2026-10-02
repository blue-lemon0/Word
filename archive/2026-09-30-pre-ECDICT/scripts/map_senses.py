# -*- coding: utf-8 -*-
"""旧义项 -> 新义项 的模糊映射，量化真实复用率。

严格相等只有 47.7%，但那是措辞差异造成的假象：
旧库「说；说明」/ 新库「说」是同一个义项。
本脚本用字符集 Jaccard 相似度做模糊匹配，输出复用率与需人工确认的清单。
"""
import collections, csv, io, json, os, re, sys
sys.stdout.reconfigure(encoding="utf-8")
PROJ = r"D:\projectX\android\Word"
B = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_b.json")
OLD = os.path.join(PROJ, "assets", "senses")


def norm(s):
    return re.sub(r"[\s，,。、；;：:（）()\[\]【】/／·\-—…\.\+]+", "", s or "")


def cjk(s):
    return "".join(re.findall(r"[\u4e00-\u9fff]", s))


def jac(a, b):
    A, B = set(a), set(b)
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


def main():
    sel = json.load(io.open(B, encoding="utf-8"))
    THR = 0.5      # 判定"同一义项"的相似度阈值
    mapped = exact = fuzzy = lost = 0
    trap_ok = trap_lost = 0
    lostlist, fuzzylist = [], []

    for w, v in sel.items():
        op = os.path.join(OLD, w + ".tsv")
        if not os.path.exists(op):
            continue
        news = [(norm(s["zh"]), cjk(s["zh"])) for s in v["senses"]]
        used = set()
        for i, ln in enumerate(io.open(op, encoding="utf-8")):
            if i == 0:
                continue
            c = (ln.rstrip("\n").split("\t") + [""] * 6)[:6]
            g, tr = norm(c[2]), c[4] == "1"
            if not g:
                continue
            gc = cjk(c[2])
            # 完全相等优先
            hit = None
            for j, (ng, nc) in enumerate(news):
                if j in used:
                    continue
                if ng == g:
                    hit, kind = j, "exact"
                    break
            if hit is None and gc:
                best, bj = 0.0, None
                for j, (ng, nc) in enumerate(news):
                    if j in used or not nc:
                        continue
                    s = jac(gc, nc)
                    if s > best:
                        best, bj = s, j
                if bj is not None and best >= THR:
                    hit, kind = bj, "fuzzy"
            if hit is None:
                lost += 1
                if tr:
                    trap_lost += 1
                if len(lostlist) < 40:
                    lostlist.append((w, c[0], c[2], c[4]))
            else:
                used.add(hit)
                mapped += 1
                if kind == "exact":
                    exact += 1
                else:
                    fuzzy += 1
                    if tr:
                        trap_ok += 1
                    if len(fuzzylist) < 30:
                        fuzzylist.append((w, c[0], c[2], v["senses"][hit]["zh"]))
                if tr:
                    trap_ok += 1

    tot = mapped + lost
    print("=" * 64)
    print("旧义项 %d 条 -> 新库 %d 义项" % (tot, sum(len(v["senses"]) for v in sel.values())))
    print("可复用 %d 条 (%.1f%%)   其中 完全一致 %d / 模糊匹配 %d"
          % (mapped, mapped / max(1, tot) * 100, exact, fuzzy))
    print("无法映射 %d 条 (%.1f%%)  其中含 TRAP 义项 %d"
          % (lost, lost / max(1, tot) * 100, trap_lost))
    print("TRAP 义项存活 %d / %d" % (trap_ok, trap_ok + trap_lost))

    print("\n模糊匹配样例 (旧 -> 新):")
    for w, sid, a, b in fuzzylist[:20]:
        print("   %-9s %-4s %-16s -> %s" % (w, sid, a, b))

    print("\n无法映射样例:")
    for w, sid, a, tr in lostlist[:25]:
        print("   %-9s %-4s %-16s trap=%s" % (w, sid, a, tr))

    # 写入映射表供句子迁移使用
    p = os.path.join(PROJ, "assets", "wordlists", "sense_map_old_to_b.json")
    print("\n建议下一步：生成 sense_map 文件后重映射 18610 条句子")


main()
