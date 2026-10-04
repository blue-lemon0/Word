# -*- coding: utf-8 -*-
"""ECDICT 义项切分器。

ECDICT 的 translation 字段按"词性大组"给义项，例如：
    passage -> "n. 通道, 通过, 移居, 航行, 一节, 走廊\nvi. 通过, 经过, 航行, 横渡, 争吵"
同一词性下逗号分隔的多个中文词其实是不同义项，但 ECDICT 把它们并在一行。
definition 字段（英文）则是逐义项的，可以拿它做切分锚点。

策略：
  1. 去掉 [计] [医] [体] 等标记义项（考研不考）
  2. 按行切（行首带词性标记 n./v./vt./vi./a./ad./prep./conj. 等）
  3. 行内按中文逗号/顿号切，保留每段的首词作为义项代表
  4. 近义词合并（可配 WordNet 校验，这里先用启发式）
"""
import csv, io, os, re, sys, json, collections
csv.field_size_limit(20 * 1024 * 1024)
sys.stdout.reconfigure(encoding="utf-8")
# ECDICT CSV 在仓库外（1.9MB，不入库）。可用环境变量 ECDICT_CSV 覆盖。
EC = os.environ.get(
    "ECDICT_CSV",
    r"C:\Users\huaiqi\AppData\Local\Temp\opencode\node_modules\ecdict\assets\ecdict.csv")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 考研不考的义项标记
SKIP_TAGS = re.compile(
    r"^\s*[\[【](计|计算机|医|体|生|化|物|数|法|商|金融|地|政|军|体|音|语|哲|心|"
    r"电|机械|矿|冶|农|林|渔|牧|生物|天文|地理|法律|医学|心理|哲学|计算机网络|"
    r"编程|程序|电脑|互联网|网络|软件|硬件|数据库|操作系统|DOS|Unix|Linux)[\]】]")

# 词性标记
POS_PAT = re.compile(
    r"^\s*((?:aux|adj|adv|abbr|art|conj|int|interj|pref|prep|pron|num|vt|vi|v|n|a|ad)\s*\.\s*)")

CJK = re.compile(r"[\u4e00-\u9fff]")
# 释义里的脏东西
DIRTY = re.compile(r"\[(计|医|体|商|法|音|语|心|哲|电|机|矿|冶|农|林|渔|牧|生|化|物|数|地|政|军|天)[^\]]*\]")


def clean(s):
    return s.strip().strip("；;，,、").strip()


def split_line(line):
    """一行 -> [(pos, [义项...])]"""
    line = line.strip()
    if not line or SKIP_TAGS.match(line):
        return None
    m = POS_PAT.match(line)
    pos, body = "", line
    if m:
        pos = m.group(1).replace(".", "").strip()
        body = line[m.end():]
    body = DIRTY.sub("", body)
    segs = [clean(x) for x in re.split(r"[,，、;；]", body)]
    segs = [x for x in segs if x and CJK.search(x)]
    return pos, segs


def parse_senses(translation):
    """ECDICT translation -> [(pos, gloss)]（去重后）"""
    out = []
    if not translation:
        return out
    # ECDICT CSV 里的换行是字面 "\n" 两个字符，必须先还原成真换行
    text = translation.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    seen = set()
    for raw in text.split("\n"):
        r = split_line(raw)
        if not r:
            continue
        pos, segs = r
        for s in segs:
            key = (pos, s)
            if key in seen:
                continue
            seen.add(key)
            out.append((pos, s))
    return out


def main():
    print("加载 ECDICT...")
    db = {}
    with io.open(EC, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            w = (r["word"] or "").strip().lower()
            if w and w not in db:
                db[w] = r
    print("词条 %d" % len(db))

    core = list(csv.DictReader(
        io.open(os.path.join(PROJ, "data", "wordlist", "kaoyan_dagang_core.tsv"),
                encoding="utf-8"), delimiter="\t"))
    words = [r["lemma"] for r in core]
    freq = {r["lemma"]: r.get("freq", "") for r in core}

    print("\n解析 3000 考研词...")
    out = {}
    dist = collections.Counter()
    drop_tag = drop_dirty = 0
    for w in words:
        r = db.get(w.lower())
        if not r:
            continue
        senses = parse_senses(r.get("translation", ""))
        if not senses:
            continue
        out[w] = {
            "pos": r.get("pos", ""),
            "collins": r.get("collins", ""),
            "oxford": r.get("oxford", ""),
            "tag": r.get("tag", ""),
            "bnc": r.get("bnc", ""),
            "frq": r.get("frq", ""),
            "freq": freq.get(w, ""),
            "definition": (r.get("definition", "") or "")
                          .replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n"),
            "senses": [{"pos": p, "zh": g} for p, g in senses],
        }
        dist[len(senses)] += 1

    tot = sum(len(v["senses"]) for v in out.values())
    print("解析成功 %d 词, 细义项 %d, 平均 %.2f" % (len(out), tot, tot / len(out)))
    print("\n义项数分布:")
    for k in sorted(dist):
        print("  %2d 义项: %4d 词 (%5.1f%%) %s" % (k, dist[k], dist[k] / len(out) * 100,
                                                  "#" * max(1, int(dist[k] / 20))))

    # 词性分布
    posd = collections.Counter(s["pos"] for v in out.values() for s in v["senses"])
    print("\n词性分布:", dict(posd.most_common()))

    # TRAP 候选：非 s1 词性的义项，或靠后的义项
    print("\n抽样（义项 + 英文 definition 对照）:")
    for w in ["passage", "abstract", "lay", "bill", "engage", "well", "address", "issue"]:
        if w not in out:
            continue
        v = out[w]
        print("  %-9s tag=%-6s %d 义项" % (w, v["tag"][:6], len(v["senses"])))
        print("     EN def: %s" % v["definition"][:110])
        for s in v["senses"][:9]:
            print("       [%-4s] %s" % (s["pos"] or "?", s["zh"]))
        if len(v["senses"]) > 9:
            print("       ... 还有 %d 个" % (len(v["senses"]) - 9))

    p = os.path.join(PROJ, "source", "ecdict_snapshot.json")
    with io.open(p, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print("\n-> %s  (%.1f MB)" % (p, os.path.getsize(p) / 1024 / 1024))


main()