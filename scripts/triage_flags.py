# -*- coding: utf-8 -*-
"""列出背单词时标记过的「这句有问题」，作为统一修改的工作清单。

    python scripts/triage_flags.py            # 全部
    python scripts/triage_flags.py --json     # 机器可读，便于喂给生成脚本
    python scripts/triage_flags.py --word cast

数据在 data/user.db 的 sentence_flag 表（背单词时点「这句有问题」写入）。
被标记的句子已经退出出题池，所以这份清单不会重复打扰。
"""
import argparse, io, json, os, sqlite3, sys, time

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(PROJ, "data", "user.db")
BUNDLE = os.path.join(PROJ, "assets", "bundle", "cards.json")


def read_flags(limit=500):
    con = sqlite3.connect("file:%s?mode=ro" % DB.replace("\\", "/"), uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT word, sense_id, sentence, note, ts FROM sentence_flag "
        "ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--word", help="只看某个词")
    ap.add_argument("--limit", type=int, default=500)
    a = ap.parse_args()

    if not os.path.exists(DB):
        print("还没有 %s —— 先跑 node app/server.mjs 练几题，标记几条就有了" % DB)
        return
    flags = read_flags(a.limit)
    if a.word:
        flags = [f for f in flags if f["word"] == a.word]

    if a.json:
        print(json.dumps(flags, ensure_ascii=False, indent=2))
        return

    if not flags:
        print("没有标记过任何句子。")
        return

    zh_of = {}
    if os.path.exists(BUNDLE):
        b = json.load(io.open(BUNDLE, encoding="utf-8"))
        zh_of = {(c["w"], c["s"]): c["zh"] for c in b["cards"]}

    words = {}
    for f in flags:
        words.setdefault(f["word"], []).append(f)

    print("共标记 %d 句，涉及 %d 个词\n" % (len(flags), len(words)))
    for w in sorted(words):
        print(w)
        for f in words[w]:
            zh = zh_of.get((f["word"], f["sense_id"]), "?")
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(f["ts"]))
            note = ("   ← " + f["note"]) if f["note"] else ""
            print("   [%s] %s" % (f["sense_id"], zh))
            print("      %s   %s%s" % (f["sentence"], when, note))

    print("\n改完 assets/sentences/<word>.tsv 后：")
    print("  python scripts/sentence_audit.py --fix-spans")
    print("  python scripts/build_bundle.py")
    print("  再把 data/user.db 里 sentence_flag 的对应行删掉，否则这句永远不出：")
    print("  sqlite3 data/user.db \"DELETE FROM sentence_flag WHERE sentence LIKE '开头几个字%'\"")


if __name__ == "__main__":
    main()