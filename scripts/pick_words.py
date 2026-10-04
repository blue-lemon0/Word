# -*- coding: utf-8 -*-
"""排出句子生成的工作清单，并给出可完成的规模估算。

    python scripts/pick_words.py            # 前 40 词 + 统计
    python scripts/pick_words.py --n 300    # 目标 300 词的清单
    python scripts/pick_words.py --done     # 只看还没做的

之前每轮都是我临时挑词、临时发现义项分不开、被 G1 打回。
这个脚本把「哪些词值得做」变成一次算得出来的结论。
"""
import argparse, csv, io, json, os, sys

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SDIR = os.path.join(PROJ, "data", "sentences")
SENSES = os.path.join(PROJ, "data", "wordlist", "senses")
FREQ_TSV = os.path.join(PROJ, "data", "wordlist", "kaoyan_dagang_core.tsv")


def load_wordlist():
    """义项真相源 = data/wordlist/senses/*.tsv + data/wordlist/kaoyan_dagang_core.tsv

    原来读的是 build/intermediate/ecdict_senses_b.json —— 那个文件被 gitignore，
    换台机器就没了，脚本直接跑不起来，属于「代码依赖派生产物」的反模式。
    改成只读 data/ 层（两层单向结构的第二层）之后，本脚本在干净 clone 上可用。

    数据等价性已核对：b.json 的 2998 个词，freq 全部能在 kaoyan_dagang_core.tsv
    里找到且一致（eastern 35 / bomb 43 / representative 48）。
    返回 {word: {"tier", "freq", "senses": [{"zh"}...]}}
    """
    freq = {}
    if not os.path.exists(FREQ_TSV):
        sys.exit("缺少 %s —— 词频真相源" % FREQ_TSV)
    with io.open(FREQ_TSV, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            f = (r.get("freq") or "").strip()
            freq[r["lemma"]] = int(f) if f.isdigit() else 999999

    sel = {}
    for fn in sorted(os.listdir(SENSES)):
        if not fn.endswith(".tsv"):
            continue
        w = fn[:-4]
        zh, tier = [], ""
        with io.open(os.path.join(SENSES, fn), encoding="utf-8") as fh:
            for r in csv.DictReader(fh, delimiter="\t"):
                zh.append(r["glossZh"])
                tier = tier or r.get("tier", "")
        sel[w] = {"tier": tier, "freq": freq.get(w, 999999),
                  "senses": [{"zh": z} for z in zh]}
    return sel

# ── 义项可分性启发式 ────────────────────────────────────
# ECDICT 把一个词切成 N 个义项，N 越多越难分。这里用两个信号：
#   1) 同一词内释义之间的**字面重合度**越高，越可能是同义切分（分不开）
#   2) 释义**长度**越短越抽象，判别词越难造
# 目标不是算出「完美」，而是把明显分不开的词排到后面去。
# 真正兜底还是 sentence_audit 的 G1/G4 —— 这里只是减少返工。

# 人工确认分不开、直接排除的词（义项是同义切分，或必须靠派生词表达）
UNSEPARABLE = {
    "classic": "杰作 = 古典作品；大艺术家 只能靠 classic artist",
    "division": "分 = 分开；分开 只能靠 divide（派生词非变形）",
    "criterion": "标准/准则/规范 三者近义，只能靠语境硬凑",
    "wonderful": "令人惊奇的/奇妙的/极好的 近义",
    "prisoner": "囚犯 = 犯人",
    "conservative": "保守的 = 守旧的",
    "excellent": "优良的 = 杰出的 = 出色的",
    "alternative": "三个义项都是「供替代的选择」的变体",
    "frequent": "时常发生的 = 频繁的",
    "theatre": "戏院 = 电影院 = 剧场",
    "soft": "软的/温和的/柔和的/柔滑的 近义",
    "shoulder": "肩 = 肩膀",
    "lady": "淑女 = 女士 = 夫人 = 贵妇",
    "arrest": "逮捕 = 拘捕",
    "shock": "震动 = 冲击 = 冲击",
    # 第二轮判断（看 T1 词频升序前 26 个时累积）
    "elect": "当选人 = 被选的人",
    "split": "裂片 vs 裂缝 分不出",
    "murder": "损毁 = 破坏",
    "festival": "节日的 = 喜庆的 = 快乐的（三个近义形容词）",
    "bid": "命令/吩咐/请求 三个近义动词",
    "withdraw": "撤回 = 撤消",
    "shoot": "射击 vs 射伤 分不出",
    "dozen": "义项「打」含义不明",
    "aircraft": "航空器 = 飞机",
    "file": "档案/公文/文件/卷宗 四个高度重叠",
    "package": "ECDICT 义项含残缺条目（『…』）",
    "camp": "露营/扎营/使扎营 分不出",
    "civil": "市民的 ≈ 公民的，中文侧近乎同义（内容已改正确，但判别价值低）",
}


def overlap(a, b):
    """两个中文释义的语义重合度。

    单靠 2-gram 会漏掉包含关系：「茶」vs「茶叶」的 2-gram 集合是
    {茶} 与 {茶叶}，交集空 -> 算出 0，而它们明显是同一个意思。
    所以额外算「短的是长的子串」这一项。
    """
    def norm(s):
        return "".join(ch for ch in s if ch.strip())
    a, b = norm(a), norm(b)
    if not a or not b:
        return 1.0
    if a in b or b in a:
        return 1.0
    ga = {a[i:i + 2] for i in range(len(a) - 1)} or {a}
    gb = {b[i:i + 2] for i in range(len(b) - 1)} or {b}
    return len(ga & gb) / len(ga | gb)


def separability(word, senses):
    """0..1，越大越好做。"""
    zh = [s["zh"] for s in senses]
    n = len(zh)
    if n == 1:
        return 1.0
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    ov = max(overlap(zh[i], zh[j]) for i, j in pairs)
    short = min(len(z) for z in zh)
    # 重合度惩罚 + 释义过短惩罚 + 全是短词的惩罚
    n_short = sum(1 for z in zh if len(z) <= 2)
    return max(0.0, 1.0 - ov * 2.2 - (0.12 if short <= 2 else 0.0)
               - (0.1 * n_short / n))


def already_done():
    if not os.path.isdir(SDIR):
        return set()
    return {f[:-4] for f in os.listdir(SDIR) if f.endswith(".tsv")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=40, help="列多少个词")
    ap.add_argument("--target", type=int, default=300, help="目标词数（用于估算）")
    ap.add_argument("--done", action="store_true", help="只看已完成的")
    a = ap.parse_args()

    sel = load_wordlist()
    done = already_done()

    rows = []
    for w, v in sel.items():
        if v["tier"] not in ("T1", "T2"):
            continue
        n = len(v["senses"])
        if n > 4:
            continue                      # 4 义项以上先不做
        if n == 1:
            continue                      # 单义项词不需例句
        f = v.get("freq", 999999)
        freq = int(f) if f is not None else 999999
        rows.append({
            "w": w, "tier": v["tier"], "n": n, "freq": freq,
            "sep": separability(w, v["senses"]),
            "zh": " / ".join(s["zh"] for s in v["senses"]),
            "done": w in done,
        })

    if a.done:
        rows = [r for r in rows if r["done"]]
        rows.sort(key=lambda r: -r["freq"])
        for r in rows:
            print("  %-13s %s  %d义  %s" % (r["w"], r["tier"], r["n"], r["zh"]))
        print("已完成 %d 词" % len(rows))
        return

    # 排序：**T1 优先，再按词频升序**。
#   freq 高 = 常见词 = 本来就会，对考研义项判别价值低；稀有的学术词才需要练。
#   （之前我按 freq 升序挑词、理由写"最该先学"，方向对；
#     后来又按可分性排序，结果 tea / bay / hip / lip 排到前面，那次是搞反了。）
#
# separability 只作**参考信息**打印，不参与排序：它抓不到语义同义
# （secure 的 无虑的/安心的/安全的/可靠 四个义项它全给 1.00）。
# 真正判断"这几个义项分不分得开"得看释义本身 —— 所以这里把释义列出来，
# 判断结果累积进 UNSEPARABLE，列表会越用越准。
    todo = [r for r in rows if not r["done"] and r["w"] not in UNSEPARABLE]
    ranked = sorted(todo, key=lambda r: (0 if r["tier"] == "T1" else 1, r["freq"]))

    def show(title, rs, k):
        print("\n== %s（%d 词）==" % (title, len(rs)))
        for r in rs[:k]:
            print("  %-13s %s f=%-6d %d义  %s" % (r["w"], r["tier"], r["freq"], r["n"], r["zh"]))

    n_done_senses = sum(len(sel[w]["senses"]) for w in done if w in sel)
    print("已完成 %d 词 / %d 义项" % (len(done), n_done_senses))
    show("T1（优先做）", [r for r in ranked if r["tier"] == "T1"], a.n)
    show("T2（次之）", [r for r in ranked if r["tier"] == "T2"], a.n // 3)
    print("\n== 明确不做（义项分不开，判断累积在这张表里）==")
    n = 0
    for w, why in UNSEPARABLE.items():
        if why:
            n += 1
            print("  %-13s %s" % (w, why))
    print("  共 %d 个" % n)

    # 规模估算
    need = sum(r["n"] * 5 for r in ranked[:a.target])
    print("\n== 规模估算 ==")
    print("  T1+T2 里 3~4 义项、且义项分得开的词：%d 个（够做）" % len(ranked))
    print("  取 %d 词 = %d 句" % (min(a.target, len(ranked)), need))
    print("  按每轮 280 句的实测产能，约 %d 轮" % (need / 280))
    print("  对比：全部 7884 义项 = 39420 句，约 %d 轮 —— 做不完，也不该做"
          % (39420 / 280))


if __name__ == "__main__":
    main()