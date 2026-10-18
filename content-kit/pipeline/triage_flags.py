# -*- coding: utf-8 -*-
"""列出背单词时标记过的「这句有问题」，作为统一修改的工作清单。

    python content-kit/pipeline/triage_flags.py                      # 全部（旧服务端库）
    python content-kit/pipeline/triage_flags.py --json               # 机器可读，便于喂给生成脚本
    python content-kit/pipeline/triage_flags.py --word cast
    python content-kit/pipeline/triage_flags.py --from app/web/flags_20261017.json

两个数据来源，同一套输出：

  * 默认读 app/state/user.db 的 sentence_flag 表 —— 旧服务端那一线。
  * --from 读浏览器端导出的 flags_*.json（格式 word-flags v1）。
    当前应用的标记写在它自己的 IndexedDB 里，这里读不到，所以由用户在
    「错题板 → 导出清单」导出；**只读那个文件，不碰浏览器数据**。

被标记的句子已经退出出题池，所以这份清单不会重复打扰。
两种来源的关单动作不同：
  旧服务端 → node app/tools/flags.mjs list / purge-stale / resolve
  浏览器端 → 错题板里的「已修好」逐条点掉
"""
import argparse, io, json, os, sqlite3, sys, time

sys.stdout.reconfigure(encoding="utf-8")
# 本工具属 content-kit，但读的是 app 的运行时状态（用户标的问题句）。
# 这是两侧少数的真实耦合点：方向固定为 内容工具 -> 只读 app 状态。
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(REPO, "app", "state", "user.db")
BUNDLE = os.path.join(REPO, "build", "bundle", "cards.json")


def read_flags_db(limit=500):
    con = sqlite3.connect("file:%s?mode=ro" % DB.replace("\\", "/"), uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT word, sense_id, sentence, note, ts FROM sentence_flag "
        "ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def read_flags_json(path, limit=500):
    """浏览器端导出的 word-flags v1。

    归一成和 DB 一样的形状：{word, sense_id, sentence, note, ts}。
    浏览器端没有全局 senseId，只有词内显示编号 slot —— 内容侧的 TSV 也是按
    (word, senseId) 组织的，所以这里把 slot 映射成 's<slot>'，
    句子原文另外拿内容包核对一次：原文不在内容包里 = 已随发布删除，
    这种标记清单里直接标「疑似已修」，不用再改。
    """
    data = json.load(io.open(path, encoding="utf-8"))
    if data.get("format") != "word-flags":
        raise SystemExit("不是 word-flags 文件（format=%r）" % data.get("format"))
    if int(data.get("schemaVersion", 0)) != 1:
        raise SystemExit("word-flags 版本不认识：%r" % data.get("schemaVersion"))

    known = {}
    if os.path.exists(BUNDLE):
        b = json.load(io.open(BUNDLE, encoding="utf-8"))
        for c in b["cards"]:
            known.setdefault(c["word"], set()).update(
                s["text"] for s in c.get("sentences", []))

    out = []
    for f in data.get("flags", []):
        pool = known.get(f["word"])
        out.append({
            "word": f["word"],
            "sense_id": "s%d" % int(f.get("slot", 1)),
            "gloss": f.get("gloss", ""),
            "sentence": f["sentence"],
            "note": f.get("note", ""),
            "stale": bool(pool is not None and f["sentence"] not in pool),
            "ts": 0,
        })
    return out[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--word", help="只看某个词")
    ap.add_argument("--from", dest="src", help="读浏览器端导出的 flags_*.json（word-flags v1）")
    ap.add_argument("--limit", type=int, default=500)
    a = ap.parse_args()

    from_json = bool(a.src)
    if from_json:
        if not os.path.exists(a.src):
            print("找不到 %s" % a.src)
            return
        flags = read_flags_json(a.src, a.limit)
    else:
        if not os.path.exists(DB):
            print("还没有 %s —— 练几题标记几条就有了；\n"
                  "浏览器端的应用请改用 --from flags_YYYYMMDD.json（错题板 → 导出清单）" % DB)
            return
        flags = read_flags_db(a.limit)

    if a.word:
        flags = [f for f in flags if f["word"] == a.word]

    if a.json:
        print(json.dumps(flags, ensure_ascii=False, indent=2))
        return

    if not flags:
        print("没有标记过任何句子。")
        return

    zh_of = {}
    if not from_json and os.path.exists(BUNDLE):
        b = json.load(io.open(BUNDLE, encoding="utf-8"))
        zh_of = {(c["word"], c["senseId"]): c["gloss"] for c in b["cards"]}

    words = {}
    for f in flags:
        words.setdefault(f["word"], []).append(f)

    stale = sum(1 for f in flags if f.get("stale"))
    print("共标记 %d 句，涉及 %d 个词%s\n" % (
        len(flags), len(words),
        "（其中 %d 句原文已不在内容包里 = 疑似已修）" % stale if stale else ""))
    for w in sorted(words):
        print(w)
        for f in words[w]:
            zh = f.get("gloss") or zh_of.get((f["word"], f["sense_id"]), "?")
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(f["ts"])) if f["ts"] else ""
            note = ("   ← " + f["note"]) if f["note"] else ""
            mark = "   [疑似已修]" if f.get("stale") else ""
            print("   [%s] %s%s" % (f["sense_id"], zh, mark))
            print("      %s   %s%s" % (f["sentence"], when, note))

    print("\n修复与关单流程：")
    print("  1. 改 content-kit/data/sentences/<word>.tsv（本工具只读，不替你改）")
    print("  2. python content-kit/pipeline/sentence_audit.py --fix-spans")
    print("  3. python content-kit/pipeline/build_bundle.py  （发布动作，确认应用能重新导入后再做）")
    if from_json:
        print("  4. 应用里重新导入内容包（标记会按原文保留），修好的句子在错题板点「已修好」关单")
        print("     —— 原文变了（标记随之消失）就是已修；只改译文的仍会保留标记，手动点掉")
    else:
        print("  4. 发布重启后，用 app 侧工具关单（不要手工进 SQLite）：")
        print("       node app/tools/flags.mjs list           # 待修 / 疑似已修 一目了然")
        print("       node app/tools/flags.mjs purge-stale    # 句子原文已随发布消失的，批量关单")
        print("     只改译文、原文没变的句子仍精确命中标记，确认修好后手动关单：")
        print("       node app/tools/flags.mjs resolve <word> <senseId> <句子开头几个字>")


if __name__ == "__main__":
    main()