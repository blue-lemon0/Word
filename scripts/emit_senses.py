# -*- coding: utf-8 -*-
"""ECDICT -> 项目 senses/*.tsv

比 build_senses.py 多一步：近义义项聚类。
`run` 的 n. 组里 跑/赛跑/奔跑/奔跑的路程 几乎是同一意思，
若都当独立义项，选项之间无法区分，训练就失去意义。

聚类规则（纯离线、保守）：
  A、B 同属一个词，且 A 是 B 的子串或二者字符重合度 >= 0.5 -> 合并
  合并后保留最短（最通用）的那个作为 glossZh，其余进 note。
只合并，不拆分。宁可少一个义项，也不要造出无法区分的假义项。
"""
import csv, io, json, os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")
PROJ = r"D:\projectX\android\Word"
FINAL = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_final.json")

SKIP_TAGS = re.compile(
    r"^\s*[\[【](计|计算机|医|体|生|化|物|数|法|商|金融|地|政|军|体|音|语|哲|心|"
    r"电|机械|矿|冶|农|林|渔|牧|生物|天文|地理|法律|医学|心理|哲学|计算机网络|"
    r"编程|程序|电脑|互联网|网络|软件|硬件|数据库|操作系统|DOS|Unix|Linux)[\]】]")
POS_PAT = re.compile(r"^\s*((?:aux|adj|adv|abbr|art|conj|int|interj|pref|prep|pron|num|vt|vi|v|n|a|ad)\s*\.\s*)")
CJK = re.compile(r"[\u4e00-\u9fff]")
DIRTY = re.compile(r"\[(计|医|体|商|法|音|语|心|哲|电|机|矿|冶|农|林|渔|牧|生|化|物|数|地|政|军|天)[^\]]*\]")
INFLECT = re.compile(r"的(过去式|过去分词|现在分词|比较级|最高级|第三人称)")
CMD = re.compile(r"(该命令|本命令|命令用于|在命令行|窗口管理器|文件锁定|硬盘分区|磁盘更动)")
MIN_LEN, MAX_LEN = 1, 9

POS_CN = {"n": "n.", "v": "v.", "vt": "vt.", "vi": "vi.", "a": "a.", "ad": "a.",
          "adv": "adv.", "prep": "prep.", "conj": "conj.", "pron": "pron.",
          "num": "num.", "int": "int.", "interj": "int.", "aux": "aux.v.",
          "abbr": "abbr.", "art": "art.", "pref": "pref.", "adj": "a."}


def bad(z):
    return bool(INFLECT.search(z) or CMD.search(z) or re.match(r"^\s*[\[【]", z)
                or not (MIN_LEN <= len(z) <= MAX_LEN) or not CJK.search(z))


def similar(a, b):
    """保留供参考：严格修饰关系判定（cluster 内部已内联实现）。"""
    if a == b:
        return True
    if abs(len(b) - len(a)) > 2:
        return False
    return (len(b) > len(a)) and (b.startswith(a) or b.endswith(a))


def cluster(senses):
    """senses: [(pos, zh, idx)] -> 合并同义后的 [(pos, zh, idx, note)]

    只合并"严格修饰关系"的一对：A 是 B 的前缀或后缀且长度差 <= 2
    （跑/赛跑、健康的/健康、使用/使用者）。
    绝不做传递式链式吸收：跑 若无差别吸收 奔跑/跑步/奔跑的路程，
    会连带吞掉竞赛、路程等不同义项，词库就被毁了。
    所以每条 B 最多被吸收一次，且 B 必须是 A 的严格前/后缀。
    """
    glosses = [z for _, z, _ in senses]
    dropped = set()     # 被吸收的下标
    absorbed = {}       # 被吸收者下标 -> 主 gloss

    for i, a in enumerate(glosses):
        if i in dropped or bad(a):
            continue
        for j, b in enumerate(glosses):
            if j == i or j in dropped or bad(b):
                continue
            if abs(len(b) - len(a)) > 2:
                continue
            if len(b) > len(a) and (b.startswith(a) or b.endswith(a)):
                dropped.add(j)
                absorbed[j] = a
                break

    out = []
    for i, (pos, z, idx) in enumerate(senses):
        if i in dropped or bad(z):
            continue
        note = []
        for j in absorbed:
            if absorbed[j] == z and glosses[j] not in note:
                note.append(glosses[j])
        out.append((pos, z, idx, note))
    return out


def main():
    final = json.load(io.open(FINAL, encoding="utf-8"))
    core = list(csv.reader(
        io.open(os.path.join(PROJ, "assets", "wordlists", "kaoyan_dagang_core.tsv"),
                encoding="utf-8"), delimiter="\t"))[1:]
    words = [r[0] for r in core]

    # 不覆盖现有 assets/senses（那里有 642 TRAP 标记、glossEn，
    # 且被 18610 条句子按 senseId 引用）。先落到独立目录做交叉验证。
    SDIR = os.path.join(PROJ, "assets", "senses_ecdict")
    os.makedirs(SDIR, exist_ok=True)
    merged_total = 0
    nwords = 0
    nsenses = 0
    for w in words:
        v = final.get(w)
        rows = []
        if v:
            cs = cluster([(s["pos"], s["zh"], i)
                          for i, s in enumerate(v["senses"])])
            merged_total += sum(len(x[3]) for x in cs)
            for pos, z, idx, note in cs:
                rows.append((POS_CN.get(pos, pos or ""), z, "/".join(note)))
        if not rows:
            continue
        nwords += 1
        nsenses += len(rows)
        p = os.path.join(SDIR, w + ".tsv")
        with io.open(p, "w", encoding="utf-8", newline="") as fh:
            fh.write("senseId\tpos\tglossZh\tglossEn\ttrap\tnote\n")
            for i, (pos, z, note) in enumerate(rows, 1):
                note_s = "/".join(note).replace("\t", " ").replace("\n", " ")
                fh.write("s%d\t%s\t%s\t\t0\t%s\n"
                         % (i, pos, z.replace("\t", " ").strip(), note_s))

    print("写出 %d 词, %d 义项, 平均 %.2f, 近义合并掉 %d" %
          (nwords, nsenses, nsenses / max(1, nwords), merged_total))
    d = collections.Counter()
    for w in words:
        p = os.path.join(SDIR, w + ".tsv")
        if os.path.exists(p):
            d[sum(1 for _ in io.open(p, encoding="utf-8")) - 1] += 1
    for k in sorted(d):
        print("   %d 义项: %4d 词 %s" % (k, d[k], "#" * max(1, int(d[k] / 15))))

    print("\n抽样:")
    for w in ["run", "well", "state", "share", "passage", "issue", "lay", "bill"]:
        p = os.path.join(SDIR, w + ".tsv")
        if not os.path.exists(p):
            continue
        lines = io.open(p, encoding="utf-8").read().strip().split("\n")
        print("  --- %s (%d 义项) ---" % (w, len(lines) - 1))
        for ln in lines[1:]:
            c = (ln.split("\t") + [""] * 6)[:6]
            print("      %-4s %-4s %-14s %s" % (c[0], c[1], c[2],
                                              ("(= " + c[5] + ")") if c[5] else ""))


main()
