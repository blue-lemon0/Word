# -*- coding: utf-8 -*-
"""从 ECDICT 原始切分结果构建最终考研义项库。

处理 5 类噪声（见 diag_senses.py 诊断）：
  1. 变位形式      "think的过去式和过去分词"  -> 丢弃
  2. 命令行说明    "该命令用于提示用户作出选择" -> 丢弃（长度 + 关键词）
  3. 单字释义      "给" "喂"                  -> 丢弃（无法做判别选项）
  4. 跨词性同义    answer "回答" n/vt/vi      -> 合并为一个义项
  5. 近义前缀细分  life "生命" / "生命线"       -> 合并（前缀被长词覆盖）
再按 bnc/frq/collins/oxford 排序，每词截断到 8 个义项。
"""
import csv, io, json, os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")
PROJ = r"D:\projectX\android\Word"
RAW = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_raw.json")

# 1. 变位形式
INFLECT = re.compile(r"的(过去式|过去分词|现在分词|比较级|最高级|第三人称)")
# 2. 命令行/软件说明
CMD = re.compile(r"(该命令|本命令|命令用于|在命令行|窗口管理器|文件锁定|硬盘分区|磁盘更动)")
# 3. 过短或过长（单字义项允许：井/泉/演/爱 都是合法核心义项，
#    它们会被下面的"前缀吸收"规则自动淘汰，而不是在这里一刀切）
MIN_LEN, MAX_LEN = 1, 9
CJK = re.compile(r"[\u4e00-\u9fff]")

# 词性保留优先级（n 最具体、最常用）
POS_RANK = {"n": 0, "vt": 1, "vi": 1, "v": 1, "a": 2, "ad": 2, "adv": 3,
            "prep": 4, "conj": 4, "pron": 4, "num": 4, "int": 5, "interj": 5,
            "aux": 6, "abbr": 6, "art": 6, "": 7}
MAX_SENSES = 8


def bad(z):
    if INFLECT.search(z) or CMD.search(z):
        return True
    if not (MIN_LEN <= len(z) <= MAX_LEN):
        return True
    if not CJK.search(z):
        return True
    # 残留的标记义项
    if re.match(r"^\s*[\[【]", z):
        return True
    return False


def priority(v, idx):
    """义项保留优先级，分数越大越优先。

    ECDICT 的 translation 字段本身就是按义项常见度排序的（高频在前），
    所以原始顺序 idx 必须主导；星级/词频只做小幅加权，
    否则 well 会丢掉核心义项「井」、share 会丢掉「分享」。
    """
    try:
        collins = float(v.get("collins") or 0)
    except ValueError:
        collins = 0.0
    try:
        oxford = float(v.get("oxford") or 0)
    except ValueError:
        oxford = 0.0
    try:
        bnc = int(v.get("bnc") or 0)
    except ValueError:
        bnc = 0
    try:
        frq = int(v.get("frq") or 0)
    except ValueError:
        frq = 0
    tag = (v.get("tag") or "").split()
    score = 100.0 - idx * 1.0                     # 原始顺序主导
    score += collins * 0.3 + oxford * 0.3          # 星级微调
    if "ky" in tag:
        score += 2.0
    score -= 1.0 / (1 + bnc) * 2.0                # 词频微调（bnc 越小越常用）
    score -= 1.0 / (1 + frq) * 2.0
    return score


def merge(zs):
    """zs: [(pos, gloss, idx)] -> 合并后的 [(pos, gloss, idx, merged_pos)]

    排序只用于"同 gloss 跨词性时挑一个 pos 作代表"，
    绝不能重排整个列表——否则原始 idx 顺序被破坏，
    而 idx 正是 ECDICT 自带的义项重要度顺序。
    """
    out = []
    where = {}   # gloss -> 在 out 中的下标
    # 找出每个 gloss 出现过的 pos 集合
    pos_of = collections.defaultdict(list)
    for pos, z, idx in zs:
        if bad(z):
            continue
        pos_of[z].append((POS_RANK.get(pos, 7), pos, idx))
    for pos, z, idx in zs:                      # 保持原始顺序遍历
        if bad(z) or z in where:
            continue
        best = min(pos_of[z])[1]                # 该 gloss 的最优词性
        where[z] = len(out)
        out.append((best, z, idx, [p for _, p, _ in pos_of[z]]))
    # 第二轮：前缀细分合并（仅 len>=2，避免误删单字核心义项如 井/演/爱）
    # 跨字同义（跑/奔跑/跑步）留给 emit_senses.py 的子串聚类处理
    drop = set()
    glosses = [o[1] for o in out]
    for i, a in enumerate(glosses):
        for j, b in enumerate(glosses):
            if i != j and not bad(b) and b.startswith(a) and len(a) >= 2:
                drop.add(i)
                break
    return [o for i, o in enumerate(out) if i not in drop]


def main():
    raw = json.load(io.open(RAW, encoding="utf-8"))
    core = list(csv.reader(
        io.open(os.path.join(PROJ, "assets", "wordlists", "kaoyan_dagang_core.tsv"),
                encoding="utf-8"), delimiter="\t"))[1:]
    words = [r[0] for r in core]

    result = {}
    stats = collections.Counter()
    for w in words:
        v = raw.get(w)
        if not v:
            stats["no_ecdict"] += 1
            continue
        zs = merge([(s["pos"], s["zh"], i) for i, s in enumerate(v["senses"])])
        if not zs:
            stats["all_dropped"] += 1
            continue
        # 排序 + 截断
        zs.sort(key=lambda t: -priority(v, t[2]))
        total_before = len(zs)
        zs = zs[:MAX_SENSES]
        if total_before > MAX_SENSES:
            stats["truncated"] += 1
        stats["dropped_total"] += total_before - len(zs)
        result[w] = {
            "pos": v.get("pos", ""),
            "collins": v.get("collins", ""),
            "oxford": v.get("oxford", ""),
            "tag": v.get("tag", ""),
            "bnc": v.get("bnc", ""),
            "frq": v.get("frq", ""),
            "freq": v.get("freq", ""),
            "senses": [{"pos": t[0], "zh": t[1], "merged_pos": t[3]} for t in zs],
        }

    dist = collections.Counter(len(v["senses"]) for v in result.values())
    tot = sum(len(v["senses"]) for v in result.values())
    print("=" * 62)
    print("最终义项库: %d 词, %d 义项, 平均 %.2f" % (len(result), tot, tot / len(result)))
    print("ECDICT 缺失 %d, 全被过滤 %d" % (stats["no_ecdict"], stats["all_dropped"]))
    print("超过 8 义项被截断的词: %d (共丢弃 %d 个义项)" % (stats["truncated"], stats["dropped_total"]))
    print("\n义项数分布:")
    for k in sorted(dist):
        print("   %d 义项: %4d 词 (%5.1f%%) %s" % (k, dist[k], dist[k] / len(result) * 100,
                                                  "#" * max(1, int(dist[k] / 15))))
    multi = sum(c for k, c in dist.items() if k >= 2)
    print("\n多义词 %d (%.1f%%)   单义词 %d" % (multi, multi / len(result) * 100,
                                                dist.get(1, 0)))
    posd = collections.Counter(s["pos"] for v in result.values() for s in v["senses"])
    print("词性分布:", dict(posd.most_common(8)))

    print("\n对照旧库验证（重点多义词）:")
    for w in ["passage", "lay", "bill", "issue", "address", "engage",
              "abstract", "well", "share", "character", "state", "run"]:
        if w not in result:
            print("   %-9s [缺失]" % w); continue
        v = result[w]
        print("   %-9s %d 义项 %s" % (w, len(v["senses"]),
                                      ("merged:" + str(v["senses"][0]["merged_pos"])
                                       if len(v["senses"][0]["merged_pos"]) > 1 else "")))
        for s in v["senses"]:
            print("        [%-3s] %s" % (s["pos"] or "?", s["zh"]))

    p = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_final.json")
    with io.open(p, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, separators=(",", ":"))
    print("\n-> %s (%.2f MB)" % (p, os.path.getsize(p) / 1024 / 1024))
    print("\n按 5 句/义项 计, 需生成句量: %d" % (tot * 5))


main()