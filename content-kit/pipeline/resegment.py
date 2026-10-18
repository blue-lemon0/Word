# -*- coding: utf-8 -*-
"""按**英文释义**重切义项，产出 data/senses_v2/<word>.tsv。

为什么按英文切
--------------
ECDICT 的 `translation`（中文）和 `definition`（英文）来自两本不同词典，
粒度不一致。实测 3000 考研词：

    英文行数 != 中文段数 的词: 2939 / 3000 = 98.0%
    每个 pos 组内两边数量都相等 的词: 44 / 3000 = 1.5%

中文侧把同义词并列切开，这是「答复/回答/答辩」变成三个义项的根因。
英文侧 `definition` 逐义项成行，是唯一可靠的**边界**来源。

分工（和 sentence_audit.py 同一个思路）
----------------------------------------
    本脚本   —— 机械可判定：按行切、pos 归一化、清洗噪声、套用配置
    decisions/<word>.json —— 语义判断：英文行如何合并成义项、glossZh 翻译
    spec.yaml —— 所有开关和例外，配置即真相源

**脚本里没有任何「这个词不好教就别做」的判断。** 语义判断全部落在
decisions/*.json 里，是可读、可审、可改的数据。spec.yaml 的 skip_words
默认空 —— 不排除任何词。

只读 content-kit/source/ecdict_snapshot.json，只写 data/senses_v2/。
绝不触碰 data/wordlist/senses/（现有发布真相源）与 build/、app/。

用法
----
    python content-kit/pipeline/resegment.py --plan                 # 全库：生成待判词表 + 英文边界
    python content-kit/pipeline/resegment.py --plan reply queen     # 只列这几个词的英文边界
    python content-kit/pipeline/resegment.py --build reply queen    # 套用 decisions，产出 v2 TSV
    python content-kit/pipeline/resegment.py --report                # v2 vs 现有 差异
    python content-kit/pipeline/resegment.py --report reply         # 只看一个词
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import collections

import yaml

sys.stdout.reconfigure(encoding="utf-8")

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE_TSV = os.path.join(KIT, "data", "wordlist", "kaoyan_dagang_core.tsv")
OLD_SE = os.path.join(KIT, "data", "wordlist", "senses")


def load_spec():
    with io.open(os.path.join(KIT, "spec.yaml"), encoding="utf-8") as fh:
        return yaml.safe_load(fh)["senses_v2"]


def load_core():
    out = []
    with io.open(CORE_TSV, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            out.append((r["lemma"].strip().lower(),
                        (r.get("tier") or "").strip()))
    return out


def load_tier(word):
    """tier 的真相源是 data/wordlist/senses/<word>.tsv，不是 kaoyan_dagang_core.tsv。

    core.tsv 的 tier 列 3000 行全是 'CORE'（那是选词范围标记，不是档位）；
    真正的 T1/T2/T3/T4 档位只在 senses 里。v2 沿用现有档位 —— 档位决定 UI
    每词保留几个义项，重新推导会与现有内容包不一致，所以只读不猜。
    """
    p = os.path.join(OLD_SE, word + ".tsv")
    if not os.path.exists(p):
        return ""
    with io.open(p, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            if (r.get("tier") or "").strip():
                return r["tier"].strip()
    return ""


def load_snapshot(cfg):
    p = os.path.join(KIT, cfg["source"])
    with io.open(p, encoding="utf-8") as fh:
        return json.load(fh)


# ── 英文行解析 ──────────────────────────────────────────────
# ECDICT definition 每行形如 "n. gloss" / "v. gloss" / "prep. See Amidst."
# 允许行首无点号（实测 282 行写成 "v put in effect"），故点号可选。
EN_POS = re.compile(
    r"^\s*((?:aux|adj|adv|abbr|art|conj|int|interj|pref|prep|pron|num"
    r"|vt|vi|v|n|a|ad|s|r)\s*\.?\s+)", re.I)

# 「见 X 条」互见行：不含义项信息
CROSSREF = re.compile(r"^\s*(see|cf\.?|compare)\s+[A-Z]", re.I)

# 百科/专名条目。判据是「这条释义在说一个具体的人/物/事件，而不是词义」。
# 必须窄：宁可漏掉一条百科义，也不要误杀正常义项。
ENCYCLOPEDIA = re.compile(
    r"\b("
    r"\d+(st|nd|rd|th)\s+President"          # 第 41 任总统
    r"|\b(18|19|20)\d{2}\b\s*[-–—]\s*(18|19|20)?\d{2}"   # 生卒年
    r"|\(born\b|\(died\b|\(b\.\s*\d"
    r"|\bPresident of the United States"
    r"|\bstatesman\b|\bpolitician who\b|\bjurist who\b|\bgynecologist\b"
    r"|\bbotanist who\b|\bphysicist who\b|\bchemist who\b"
    r"|\bisraeli\b|\bAmerican\b|\bBritish statesman\b"
    r"|\bKing of\b|\bQueen of\b|\bEmperor\b"
    r"|\bwas an? \w+ (who|which)\b"
    r")",
    re.I)


def parse_en_lines(definition, cfg):
    """ECDICT definition -> [(pos, body, raw_index)]，已按 pos 归一化。"""
    pos_map = {str(k).lower(): v for k, v in cfg["pos_map"].items()}
    out = []
    for raw_idx, line in enumerate((definition or "").split("\n")):
        line = line.strip()
        if not line:
            continue
        m = EN_POS.match(line)
        if not m:
            # 无行首词性标记：整行当正文，pos 待 AI 在 decisions 里指定。
            out.append(("", line, raw_idx))
            continue
        tag = m.group(1).strip().rstrip(".").lower()
        body = line[m.end():].strip()
        out.append((pos_map.get(tag, tag + "."), body, raw_idx))
    return out


def clean_line(pos, body, cfg):
    """机械清洗。返回 (保留?, 丢弃原因)。"""
    if not body:
        return False, "empty"
    if cfg.get("drop_cross_reference") and CROSSREF.match(body):
        return False, "cross_reference"
    if cfg.get("drop_encyclopedia") and ENCYCLOPEDIA.search(body):
        return False, "encyclopedia"
    if len(body.split()) < int(cfg.get("min_en_words", 4)):
        return False, "too_short"
    return True, ""


def english_units(word, snap, cfg, with_supplement=True):
    """一个词的英文边界 -> ([unit...], [dropped...])。

    unit = {'pos','body','raw','from'}，from ∈ {ECDICT, WORDNET}。
    ECDICT 的 definition 是边界主源（已被筛过一轮）；WordNet 补缺它漏掉的。

    raw 的类型：ECDICT 侧是 int（definition 里的行号），
    WordNet 侧是 ("wn", idx) —— decisions 的 fromLines 要能同时引用两者。
    """
    v = snap.get(word)
    kept, dropped = [], []
    known = set()
    if v:
        for pos, body, raw in parse_en_lines(v.get("definition"), cfg):
            ok, why = clean_line(pos, body, cfg)
            if ok:
                kept.append({"pos": pos, "body": body,
                             "raw": raw, "from": "ECDICT"})
                known.add(_gloss_key(body))
            else:
                dropped.append({"pos": pos, "body": body,
                                "raw": raw, "why": why})
    if with_supplement:
        kept.extend(wordnet_extra_units(cfg, word, known))
    keep_pos = set(cfg.get("keep_pos") or [])
    if keep_pos:
        filtered = [u for u in kept if u["pos"] not in keep_pos]
        if filtered:
            kept = [u for u in kept if u["pos"] in keep_pos]
            for u in filtered:
                dropped.append({**u, "why": "pos_not_kept"})
    return kept, dropped


def norm_pos(p):
    """把词性归到比较用的粗类：英文 v. 覆盖中文 vt./vi.，a/ad 同类。"""
    p = (p or "").strip().rstrip(".").lower()
    if p in ("v", "vt", "vi"):
        return "v"
    if p in ("a", "ad"):
        return "a"
    return p


def zh_units(word):
    """现有中文义项 -> [(pos, glossZh, idx)]，按发布顺序。

    只在 spec.yaml 的 supplement_missing_pos 打开、且英文对某词性零覆盖时使用。
    读的是 data/wordlist/senses/（现有发布真相源），只读不写。
    """
    p = os.path.join(OLD_SE, word + ".tsv")
    if not os.path.exists(p):
        return []
    out = []
    with io.open(p, encoding="utf-8") as fh:
        for i, r in enumerate(csv.DictReader(fh, delimiter="\t")):
            zh = (r.get("glossZh") or "").strip()
            if zh:
                out.append((r.get("pos", ""), zh, i))
    return out


_DROP_LEXNAME_CACHE = None
_DROP_PAT_CACHE = None
_DROP_USAGE_CACHE = None


def _supplement_cfg():
    return load_spec().get("supplement") or {}


def _drop_lexnames():
    global _DROP_LEXNAME_CACHE
    if _DROP_LEXNAME_CACHE is None:
        _DROP_LEXNAME_CACHE = set(_supplement_cfg().get("drop_lexnames") or [])
    return _DROP_LEXNAME_CACHE


def _drop_patterns():
    global _DROP_PAT_CACHE
    if _DROP_PAT_CACHE is None:
        _DROP_PAT_CACHE = [re.compile(p) for p in
                           (_supplement_cfg().get("drop_patterns") or [])]
    return _DROP_PAT_CACHE


def _drop_usage():
    global _DROP_USAGE_CACHE
    if _DROP_USAGE_CACHE is None:
        _DROP_USAGE_CACHE = set(
            _supplement_cfg().get("drop_usage_domains") or [])
    return _DROP_USAGE_CACHE


def _gloss_key(body):
    """跨源去重键。

    ECDICT 与 WordNet 是同一条 WordNet 释义的两份转存，文本会差在
    标点与空格上：`very good; of the highest quality` vs
    `very good;of the highest quality`。用原始串比对会把同一条义项
    当成两条（实测 144 对）。这里做**保守**归一：只压空白与分号间距，
    不做分词、不做词形还原 —— 宁可漏判（走 decisions 人工确认），
    不错判（误删真义项）。
    """
    s = re.sub(r"\s+", " ", body.strip())
    s = re.sub(r"\s*;\s*", "; ", s)
    s = re.sub(r"\s*;\s*(?:,\s*)?$", "", s)
    s = s.rstrip().rstrip('"\'`\u201d').strip().lower()
    s = _strip_citation(s)
    if _clause_min_words() <= 0:
        return s
    # 首分句够长时用首分句当键 —— WordNet 释义首分句是核心定义，
    # 分号之后全是例句/引文，两源转存时最容易在这里分叉。
    # 首分句过短则退回全文比对：`until prep. to` / `when adv. at what time`
    # 这类会误合并（实测 3/8378），故加长度门槛。
    head = s.split(";")[0]
    if len(head.split()) >= _clause_min_words():
        return head
    return s


# WordNet 尾部引文署名：`...; - B. Russell` / `... - Sherwood Anderson`。
# 两源转存时署名有无不一致，纯属元数据不含词义，故从去重键里剥掉。
_CITATION = re.compile(
    r"(?:;\s*)?[-–]\s*[^;]{0,48}$")


def _strip_citation(s):
    m = _CITATION.search(s)
    if not m:
        return s
    tail = s[m.start():]
    # 尾部必须像个署名：短、无分号、以连字符开头，且不含引号
    if len(tail.split()) <= 5 and '"' not in tail and "'" not in tail:
        return s[:m.start()].strip().rstrip(",;").strip()
    return s


_CLAUSE_MIN_CACHE = None


def _clause_min_words():
    """惰性读 config —— 不能在模块导入期调用（spec 尚未加载）。"""
    global _CLAUSE_MIN_CACHE
    if _CLAUSE_MIN_CACHE is None:
        _CLAUSE_MIN_CACHE = int(
            _supplement_cfg().get("dedup_clause_min_words") or 6)
    return _CLAUSE_MIN_CACHE


def wordnet_extra_units(cfg, word, known_bodies):
    """WordNet 独有义项（ECDICT 没收录的），已按 config 过滤噪声。

    返回 [{pos, body, raw, from}]，raw 用 ("wn", idx) 标记以便 decisions 引用。

    这是「补缺层」：ECDICT 已替我们筛过一轮（专名/罕见义挡掉大部分），
    WordNet 补上它漏掉的真义项（author 的 writer.n.01、social 的 sociable.n.01）。
    代价是 WordNet 本身噪声多（well 多 21 条），所以过滤规则全部走 config。

    ⚠️ 过滤不掉的：usage_domain 只覆盖 1.1% 的义项（实测 101/9380），
    `can = 浮标` / `will = 遗嘱` 这类 WordNet 根本没打标签。
    所以补缺层产出的义项**必须逐词人工确认**，不能直接落盘。
    """
    sc = _supplement_cfg()
    if not sc.get("enabled"):
        return []
    wn = wordnet_roots()
    if wn is None:
        return []
    out = []
    lex_drop = _drop_lexnames()
    pats = _drop_patterns()
    usage_drop = _drop_usage()
    min_words = int(sc.get("min_en_words", 3))
    idx = 0
    for s in first_word_synsets(word, wn, exceptions_for(word)):
        body = s.definition().strip()
        is_exc = s.name() in set(exceptions_for(word) or ())
        # 跨源去重（D28）。**例外不豁免去重** —— 例外的目的是救回
        # ECDICT 漏掉的义项，若 ECDICT 已经有了，再放一份副本只会让
        # 同一个意思在 plan 里出现两次（lay eggs / mental ability 都踩过）。
        # 保留例外的只有「过滤」豁免（lexname / pattern / usage / min_en_words）。
        if _gloss_key(body) in known_bodies:
            continue
        # 显式声明的例外**绕过全部过滤**。它们是人工确认过的义位：
        #   arrest  collar.v.01 / check.v.18   （首词非 arrest，见 D27）
        #   bomb    bombard.v.02 / turkey.n.05  （首词非 bomb，同型）
        # 例外可能落在 noun.person（专名）或短释义上 —— 但既然人工指定了，
        # 就不该再被自动规则否决，否则 decisions 与产出不一致，比报错更难查。
        if not is_exc:
            if s.lexname() in lex_drop:
                continue
            if any(p.search(body) for p in pats):
                continue
            ud = s.usage_domains()
            if ud and any(d.name() in usage_drop for d in ud):
                continue
            if len(body.split()) < min_words:
                continue
        out.append({"pos": WN_POS.get(s.pos(), s.pos() + "."),
                    "body": body,
                    # raw 同时给出序号与 synset 名，decisions 两种写法都能引用：
                    #   ["wn", 3]      按序号（旧 decisions 的写法）
                    #   ["wn", "a.b.01"] 按名字（稳定，跨 WordNet 版本不变）
                    "raw": ("wn", idx, s.name()),
                    "from": "WORDNET"})
        idx += 1
    return out


def wordnet_roots():
    """返回 Princeton WordNet 3.0句柄；不可用时返回 None。

    离线读取 content-kit/source/wordnet/（vendor 的 zip，见同目录 PROVENANCE.md）。
    没有它整个脚本仍可用 —— 只是缺了补缺层与可判别性信号。
    """
    global _WN
    if _WN is not None:
        return _WN or None
    root = os.path.join(KIT, (_supplement_cfg().get("wordnet_dir")
                              or "source/wordnet"))
    if not os.path.isdir(root):
        _WN = False
        return None
    try:
        import nltk
        if root not in nltk.data.path:
            nltk.data.path.insert(0, root)
        from nltk.corpus import wordnet as wn
        wn.synsets("the")          # 触发加载，失败会抛
        _WN = wn
    except Exception as exc:        # noqa: BLE001 - 缺 WordNet 不该让主流程挂掉
        sys.stderr.write("[提示] WordNet 不可用（%s），"
                         "可判别性信号与补缺层将跳过\n" % exc)
        _WN = False
        return None
    return wn


_WN = None

# WordNet 的 pos 标记（n/v/a/r）与我们内部用的 n./v./a./adv. 的对应。
# 注意 WordNet 的 r. = adverb（罗杰特体系），s. = adjective，
# 与 ECDICT 一样需要归一化。
WN_POS = {"n": "n.", "v": "v.", "a": "a.", "s": "a.",
          "r": "adv.", "adv": "adv."}


def first_word_synsets(word, wn, extra=None):
    """只收以该词为首词的 synset（可显式追加例外）。

    为什么必须这样收：`wn.synsets("reply")` 会返回 `answer.n.01` ——
    那是「答案」的义项，不是「答复」的。放宽到「任意 lemma 含该词」实测代价：
    全库义位 12805 -> 19744（+54%），find 6->18、cut 54->70，
    同义词污染全回来（`find` 作为同义词出现在 12 个别的 synset 里）。

    `extra` 是显式例外（synset 名），用于 ECDICT 数据错误的词：
    见 docs/decisions/D27 的 arrest —— ECDICT 只导入了 arrest.n.02
    （心脏骤停后的停搏状态），而「逮捕」挂在 collar.v.01 / check.v.18 下，
    首词规则把常用义全过滤掉了。这类词由 decisions 的 _exceptions 显式声明。
    """
    out = []
    want = set(extra or ())
    seen = set()
    for s in wn.synsets(word):
        if s.name() in want:
            out.append(s)
            seen.add(s.name())
            continue
        lemmas = s.lemmas()
        if lemmas and lemmas[0].name() == word:
            out.append(s)
    # 例外里可能有不以本词为 lemma 的 synset（首词完全不同），
    # wn.synsets(word) 查不到它们，必须按 synset 名直接解析。
    #   sharp.v.03 "strike out (a batter)" 的首 lemma 是 strike，
    #   但它确实是 sharp 的义项（a sharp 是三振手）—— 不解析就会静默丢失。
    for name in sorted(want - seen):
        try:
            s = wn.synset(name)
        except Exception:                # noqa: BLE001 - 名字写错时明确跳过
            print("  [警告] 例外 synset 名字不存在: %s (%s)" % (name, word))
            continue
        if s is not None:
            out.append(s)
    return out


def exceptions_for(word):
    """本词**显式指定**必须收入的 WordNet synset 名集合。

    两个来源，作用相同（都是「人工指定，绕过自动过滤」，见 D27）：

      1. `_wordnet_exceptions` —— 声明式，只说不引用
      2. `senses[*].fromLines` 里的 ["wn", "synset.name"] —— 引用式

    第 2 条是必需的：decisions 里直接引用的 synset 若恰好落在
    lexname/usage_domain/min_en_words 的过滤范围内，就会出现
    「引用了但产出没有」，报错信息还指向「已被清洗掉的英文行」，
    很难查。两条路打通后，写法可以二选一，行为一致。

    与 _exceptions（自由文本说明）分开：那个是给人看的，这个是机器执行的。
    """
    dec = load_decisions(load_spec(), word) or {}
    names = set(dec.get("_wordnet_exceptions") or [])
    for s in dec.get("senses") or []:
        if not isinstance(s, dict):                # 容错：senses 被写成裸数组时跳过
            continue
        refs = s.get("fromLines")
        if not isinstance(refs, list):              # 容错：标量（int）当单元素处理
            refs = [refs] if refs is not None else []
        for ref in refs:
            if (isinstance(ref, (list, tuple)) and len(ref) == 2
                    and ref[0] == "wn" and isinstance(ref[1], str)):
                names.add(ref[1])
    return names


def path_sim(wn, a, b):
    """两个 synset 的语义相似度 0..1。够用即可 —— 只用来提示「疑似同义」，
    不用来自动合并（实测 >=0.90 的也只有 10 对，样本太小，不足以下结论）。"""
    try:
        d = a.shortest_path_distance(b)
        return max(0.0, 1.0 - d / 10.0)
    except Exception:                # noqa: BLE001 - 不同 pos 的 synset 距离可能无解
        return None


def separability_flags(cfg, word, units):
    """标出疑似同义的义项对，交给人工确认。返回 [(i, j, sim)]。

    为什么只标记不合并：这个判定是「提示」不是「结论」。7752 个词内义项对里
    path_sim>0.75 的只有 206 个(2.7%)，样本太小，而且实测这些对里
    「undertake a journey」vs「make a trip for pleasure」确实该合并，
    但「accept as true」vs「follow a credo」不该合并 —— 得分区分不出来。
    """
    wn = wordnet_roots()
    thr = float(cfg.get("separability_path_sim", 0.75))
    if wn is None:
        return []
    syns = first_word_synsets(word, wn)
    matched = []
    for u in units:
        for s in syns:
            if s.definition().strip() == u["body"]:
                matched.append((u, s))
                break
    hits = []
    for i in range(len(matched)):
        for j in range(i + 1, len(matched)):
            sim = path_sim(wn, matched[i][1], matched[j][1])
            if sim is not None and sim > thr:
                hits.append((i, j, sim))
    return hits


def decision_senses(dec, by_raw):
    """从 decision 解析出产出义项的 (pos, glossZh, glossEn)。

    只做解析不做校验 —— cmd_build 用它出 TSV，队列用它比对义项对。
    抽出来是为了保证两边看到的是**同一份产出**，否则队列报的差异
    在 build 里根本不存在（之前就踩过：队列比的是全部边界，
    于是把「已合并成一条义项的两个边界」报成疑似同义，纯噪音）。
    """
    out = []
    for s in dec.get("senses") or []:
        fl = s.get("fromLines") or []
        if not isinstance(fl, list):
            fl = [fl]                  # 容错：标量当单元素
        raws = [_raw_key(r) for r in fl]
        zh = (s.get("glossZh") or "").strip()
        if raws and all(r in by_raw for r in raws):
            en = " / ".join(clean_gloss(by_raw[r]["body"]) for r in raws)
            pos = s.get("pos") or by_raw[raws[0]]["pos"]
        else:
            en = ""
            pos = s.get("pos") or ""
        out.append((pos, zh, en))
    return out


_EN_STOP = frozenset("""a an the of to in for or and is are be been by with that this
it its as on at from any one who not no s t d which such than then there their
have has had do does did will would can could may might must shall""".split())


def _en_tokset(en):
    return frozenset(w for w in re.findall(r"[a-z]+", en.lower())
                     if len(w) > 2 and w not in _EN_STOP)


def _zh_bigrams(zh):
    return frozenset(zh[i:i + 2] for i in range(len(zh) - 1))


def _jac(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def confusable_pairs(cfg, dec, by_raw, en_thr=0.6, zh_thr=0.5):
    """产出义项里**用户可能分不开**的义项对。返回 [(i, j, en_jac, zh_jac)]。

    这是 review 队列唯一值得保留的信号，直接对应用户最初的抱怨
    ——「为什么有相似义项」。判据两条，都是可复算的：

      en_jac >= 0.6   两条义项的英文释义词级重合 60% 以上
      zh_jac >= 0.5   两条义项的中文释义 2-gram 重合 50% 以上

    阈值是定标出来的，不是拍的。合成正/负例扫描：

      en>=0.50  正例 3/3   负例 1/3 误报(犯罪/罪恶)
      en>=0.60  正例 3/3   负例 0/3      ← 取这个
      en>=0.70  正例 2/3   负例 0/3   （漏掉 en_jac=0.667 的那条）
      en>=0.80  正例 2/3   负例 0/3

    74 个已产出词上误报 0。zh 判据留着是因为 **fromZh 义项的 glossEn 为空**，
    两条 ZH-FALLBACK 义项的 en_jac 恒为 0，只有中文判据能兜住。

    为什么不再用 path_sim >= 0.75：实测 0.80 是同 synset 族相邻义项的
    **结构性地板**（crime 犯罪/罪恶、agent 抽象动因/作用物质 全落在 0.80），
    而这些恰恰是我有意保留的真区分。这类信号只会把「已判定的结果」
    反复报成待办，稀释真正的信号。
    """
    senses = decision_senses(dec, by_raw)
    hits = []
    for i in range(len(senses)):
        for j in range(i + 1, len(senses)):
            ej = _jac(_en_tokset(senses[i][2]), _en_tokset(senses[j][2]))
            zj = _jac(_zh_bigrams(senses[i][1]), _zh_bigrams(senses[j][1]))
            if ej >= en_thr or zj >= zh_thr:
                hits.append((i + 1, j + 1, round(ej, 2), round(zj, 2),
                             senses[i][1][:24], senses[j][1][:24]))
    return hits


_GLOSS_TRAIL_EX = re.compile(
    r"""(?:;\s*)?          # 可选的分号分隔
        (?:e\.g\.|i\.e\.|ex\.)\s*,?\s*     # e.g. / i.e. / ex.
        ["'`]([^"'`]{3,})["'`]            # 第一个引号对
        .*                                # 该例句的后续（含未闭合的引号）
        $""", re.X | re.S)

# ── 教训：宽泛的「例句标记」会误伤释义本体 ─────────────
# 第一版用 e.g./as in/used in/人名 当「后面是例句」的信号，结果改动了 425/8400 条
# （5.1%），而真正该修的只有约 39 条。误伤的都是释义本体：
#   come upon, as if by accident; meet with   <- "as if by accident" 是释义
#   a workplace; as in the expression "on the job"
#   lead a certain kind of life; live in a certain style  <- 两边都是并列义项
# 「并列义项」和「释义+例句」在文本上无法可靠区分 —— 都有分号。
#
# 现在的判据收紧到只有一种情况：**e.g. 后面紧跟带引号的短语**。
# `meet with` / `live in a certain style` 不带 e.g.，一律保留。
# 宁可留一段例句文字在界面上，也不要削掉半个释义。
_GLOSS_EXAMPLE_MARK = re.compile(r"^\s*(?:e\.g\.|i\.e\.|ex\.)\s*,?\s*[\"'`]", re.I)

# 保留段落的最小词数 —— 低于此值说明切错了方向
_GLOSS_KEEP_MIN_WORDS = 6


def clean_gloss(body):
    """清洗 WordNet gloss 的历史遗留脏数据。**不改变切分，只改显示。**

    只修三类**确凿**的问题（实测 8400 条里约 39 条，约 0.5%）：

      1. 空占位："; ; ; ; ,"  → 去掉        无争议
      2. 行尾未闭合引号：`...came out better"` → 去掉    无争议
      3. `e.g. "example"` 形式的内嵌例句      -> 截断到 e.g. 之前

    刻意**不**做的：
      - 不按分号切分义项。"come upon, as if by accident; meet with" 里
        分号两侧都是释义，WordNet 这么写不代表右侧是例句
      - 不碰 "as in the expression" 这类（第一版误伤 425 条的元凶）

    设计原则：**宁可留一段例句文字在界面上，也不要削掉半个释义。**
    界面上的瑕疵是美观问题，释义残缺是正确性问题。
    """
    cg = load_spec().get("clean_gloss") or {}
    out = body
    if cg.get("squeeze_semicolons", True):
        out = re.sub(r"\s*;\s*(?:;\s*)+", "; ", out)
        out = re.sub(r"\s*;\s*(?:,\s*)?$", "", out)
    if cg.get("drop_trailing_examples", True):
        parts = out.split(";")
        for i, seg in enumerate(parts):
            if i == 0:
                continue
            if _GLOSS_EXAMPLE_MARK.match(seg):
                keep = "; ".join(parts[:i]).strip()
                if len(keep.split()) >= _GLOSS_KEEP_MIN_WORDS:
                    out = keep
                break
    if cg.get("strip_trailing_quote", True):
        out = re.sub(r'["\'`\u201d]+$', "", out.rstrip())
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out or body


def keep_cap_for(word):
    """该词的**硬**上限（数据事故保险）。可因词而异，未配置则取全局。

    D21 查清 keep_per_tier 的来历后已取消内容上限：它当初是为对抗中文过度切分
    （平均 5.9 段/词）设的防御参数，不是内容规格，换英文切分后理由消失。
    现在只剩 safety_cap 一个远高于任何真实值的保险（40，最极端 cut 约 47，
    已由 max_senses_soft 的软阈值提前拦在人工确认环节）。
    """
    spec = load_spec()
    caps = spec.get("keep_per_tier")
    if caps:
        return caps.get(load_tier(word))
    return int(spec.get("safety_cap") or 0) or None


def soft_cap():
    """软阈值：超出不删内容，但要求 decisions 显式说明如何合并细分义项。"""
    return int(load_spec().get("max_senses_soft") or 0) or None


def _raw_key(r):
    """把 decisions 里 fromLines 的元素归一成可哈希的 raw 键。

    两种形态：
        0        -> ECDICT definition 的行号（int）
        ["wn",3] -> WordNet 补缺项的第 3 个首词 synset（JSON 数组）
    """
    if isinstance(r, (list, tuple)):
        return tuple(r)
    return r


def missing_pos_units(word, kept):
    """英文零覆盖的词性，从现有中文义项里取出候选。"""
    if not load_spec().get("supplement_missing_pos", False):
        return []
    have = {norm_pos(u["pos"]) for u in kept if u["pos"]}
    return [u for u in zh_units(word) if u[0] and norm_pos(u[0]) not in have]


def active_skip(cfg):
    """当前真正要跳过的词。

    两个来源：
      spec.yaml 的 senses_v2.skip_words   —— 显式配置，默认空
      pick_words.UNSEPARABLE              —— 历史累积表，其中 value=None 的条目
                                           表示「按英文边界重判后可分」，不算跳过

    「不排除任何词」是默认立场（用户 2026-10 明确）：遇到觉得没必要或太简单的词，
    用户自己在 app 里标记学会，不需要产线替他们过滤。所以这张表默认应为空。
    """
    skip = dict(cfg.get("skip_words") or {})
    try:
        import pick_words as _pw
        for _w, _why in getattr(_pw, "UNSEPARABLE", {}).items():
            if _why is None:
                skip.pop(_w, None)
    except Exception:                    # noqa: BLE001 - 表不存在不影响重切
        pass
    return skip


def cmd_plan(cfg, snap, words):
    """列出英文边界 + 待 AI 决策清单。不写任何文件。"""
    core = dict(load_core())
    tiers = {w: load_tier(w) for w, _ in load_core()}
    skip = active_skip(cfg)
    targets = words or [w for w, _ in load_core()]
    n_words = 0
    n_units = 0
    dist = collections.Counter()
    drop = collections.Counter()
    print("=" * 70)
    print("英文边界统计（切分的真相源）")
    print("=" * 70)
    for w in targets:
        if w in skip:
            print("  [skip_words] %-12s 理由: %s" % (w, skip[w]))
            continue
        kept, dropped = english_units(w, snap, cfg)
        if not kept:
            continue
        n_words += 1
        n_units += len(kept)
        dist[len(kept)] += 1
        for d in dropped:
            drop[d["why"]] += 1
        if words:
            print("\n--- %s  (%s/%s, %d 英文边界)"
                  % (w, core.get(w, "?"), tiers.get(w, "?"), len(kept)))
            for i, u in enumerate(kept):
                mark = "  <-WORDNET补缺" if u.get("from") == "WORDNET" else ""
                print("   E%d [%-4s] %s%s"
                      % (i + 1, u["pos"] or "?", u["body"], mark))
            for d in dropped:
                print("   -- 丢弃(%s) [%-4s] %s" % (d["why"], d["pos"] or "?", d["body"][:70]))
            fb = missing_pos_units(w, kept)
            if fb:
                print("   [ZH-FALLBACK 候选] 英文对该词性零覆盖，从现有中文义项补：")
                for pos, zh, idx in fb:
                    print("      Z%d [%-4s] %s" % (idx, pos or "?", zh))
            cap = keep_cap_for(w)
            if cap and len(kept) > cap:
                print("   [上限] %s 每词留 %d 个，当前英文边界 %d 个 -> 需截断 %d 个"
                      % (tiers.get(w, "?"), cap, len(kept), len(kept) - cap))
            sep = separability_flags(cfg, w, kept)
            if sep:
                print("   [疑似同义] 以下义项对语义重叠高，需人工判断是否合并：")
                for i, j, sim in sep:
                    print("      %.2f  E%d %s" % (sim, i + 1, kept[i]["body"][:62]))
                    print("            E%d %s" % (j + 1, kept[j]["body"][:62]))
    print("\n" + "=" * 70)
    print("有英文边界的词: %d, 英文边界总数: %d, 平均 %.2f"
          % (n_words, n_units, n_units / max(1, n_words)))
    print("每词边界数分布:")
    for k in sorted(dist):
        print("   %d 边界: %4d 词" % (k, dist[k]))
    print("清洗丢弃统计:", dict(drop.most_common()))
    print("\n下一步：对每个词在 %s 写 decisions（合并哪些英文行 + glossZh 翻译）"
          % cfg["decisions_dir"])


def load_decisions(cfg, word):
    p = os.path.join(KIT, cfg["decisions_dir"], word + ".json")
    if not os.path.exists(p):
        return None
    with io.open(p, encoding="utf-8") as fh:
        return json.load(fh)


def cmd_build(cfg, snap, words, dry=False):
    """套用 decisions，产出 data/senses_v2/<word>.tsv。"""
    out_dir = os.path.join(KIT, cfg["out_dir"])
    core = dict(load_core())
    skip = active_skip(cfg)
    targets = words or sorted(load_decisions(cfg, w) and w or w
                              for w, _ in load_core()
                              if load_decisions(cfg, w))
    built = 0
    missing = []
    total_senses = 0
    for w in targets:
        if w in skip:
            continue
        dec = load_decisions(cfg, w)
        if dec is None:
            missing.append(w)
            continue
        kept, _ = english_units(w, snap, cfg)
        # 同一 raw 有两种键形态：("wn", 序号, synset名)。decisions 里的
        # ["wn", 3]（序号）与 ["wn", "a.b.01"]（名字）都要能查到。
        by_raw = {}
        for u in kept:
            by_raw[u["raw"]] = u
            if u["from"] == "WORDNET":
                by_raw[("wn", u["raw"][1])] = u
                by_raw[("wn", u["raw"][2])] = u
        zh_by_idx = {i: (pos, zh) for pos, zh, i in zh_units(w)}
        # raw 的类型有三种：int（ECDICT 行号）、("wn", idx)（WordNet 补缺）、
        # None（fromZh 纯中文补洞）。decisions 的 fromLines 都可以引用。
        rows = []
        bad = []
        for i, s in enumerate(dec["senses"], 1):
            # fromLines 的元素有两种形态：int（ECDICT definition 行号）和
            # ["wn", idx]（WordNet 补缺项）。JSON 数组天然读成 list，
            # 这里统一归一成可哈希的键：int 保持原样，list 转 tuple。
            _fl = s.get("fromLines") or []
            if not isinstance(_fl, list):
                _fl = [_fl]              # 容错：标量当单元素
            raws = [_raw_key(r) for r in _fl]
            zh_idx = s.get("fromZh") or []
            if not raws and not zh_idx:
                bad.append("s%d 既无 fromLines 也无 fromZh" % i)
                continue
            miss = [r for r in raws if r not in by_raw]
            if miss:
                bad.append("s%d 引用了已被清洗掉的英文行 raw=%s" % (i, miss))
                continue
            mz = [z for z in zh_idx if z not in zh_by_idx]
            if mz:
                bad.append("s%d 引用了不存在的现有义项下标 fromZh=%s" % (i, mz))
                continue
            if raws:
                pos = s.get("pos") or by_raw[raws[0]]["pos"]
                gloss_en = " / ".join(clean_gloss(by_raw[r]["body"])
                                    for r in raws).strip()
                src = {by_raw[r].get("from") for r in raws}
                origin = "EN"
                if "WORDNET" in src:
                    origin = "EN-WORDNET"
            else:
                # ZH-FALLBACK：英文对���词性零覆盖，从现有中文义项补。
                pos = s.get("pos") or zh_by_idx[zh_idx[0]][0]
                gloss_en = ""
                origin = "ZH-FALLBACK"
            gloss_zh = (s.get("glossZh") or "").strip()
            if not gloss_zh:
                bad.append("s%d glossZh 为空" % i)
                continue
            note = s.get("note", "")
            if origin == "EN-WORDNET":
                note = ("[WORDNET 补缺 ECDICT 未收录] " + note).strip()
            elif origin == "ZH-FALLBACK":
                note = ("[ZH-FALLBACK 英文零覆盖] " + note).strip()
            if not gloss_en:
                note = ("[glossEn 空：ECDICT 与 WordNet 均无对应义位] "
                        + note).strip()
            rows.append({
                "senseId": "s%d" % i,
                "pos": pos,
                "glossZh": gloss_zh,
                "glossEn": gloss_en,
                "tier": load_tier(w),
                "trap": "0",
                "note": note,
            })
        # ── 旧义项账目守卫 ────────────────────────────────
        # 每个现有义项必须在下面三种状态里恰好出现一次：
        #   fromZh 接住 / _oldSenses action=merged（并入某个英文义项）
        #   _oldSenses action=dropped（舍弃，必须写理由）
        # 否则它会悄悄消失。一个几十行的批次就能吃掉别处的内容 ——
        # 这是最危险的失败模式，必须让它变成硬错误而不是事后才发现。
        all_zh = {i: zh for _, zh, i in zh_units(w)}
        taken = set()
        for s in dec["senses"]:
            taken |= set(s.get("fromZh") or [])
        ledger = {}
        for entry in (dec.get("_oldSenses") or []):
            i = entry.get("oldSenseIndex")
            if i is None:
                continue
            if i in ledger:
                bad.append("现有义项下标 %s 在 _oldSenses 里重复出现" % i)
            ledger[i] = entry
        lost = sorted(set(all_zh) - taken - set(ledger))
        if lost:
            bad.append("现有义项 %s 既未接住也未在 _oldSenses 说明"
                       % [(i, all_zh[i]) for i in lost])
        for i, entry in sorted(ledger.items()):
            if entry.get("action") == "dropped" and not (entry.get("reason") or "").strip():
                bad.append("现有义项下标 %s 标为 dropped 但没写理由" % i)
# ── safety_cap：只防数据事故，不做内容截断 ───────────
        # 真正的每词上限（T1:4/T2:3…）已按 D21 取消 —— 那是防御旧中文
        # 过度切分的参数，不是内容规格。这里只留一个远高于任何真实值的
        # 保险（40，最极端的 well 约 21），触发即报错要求人工处理。
        cap = keep_cap_for(w)
        over_txt = ""
        if cap and len(rows) > cap:
            over_txt = ("产出 %d 义项 > safety_cap %d：%s"
                        % (len(rows), cap,
                           ", ".join("%s[%s]" % (r["glossZh"], r["pos"])
                                     for r in rows[cap:cap + 3]) + " ..."))
            bad.append("疑似数据事故 " + over_txt)
        soft = soft_cap()
# 仅告警，不拦（D24）。原本这里会报错要求合并，理由是「造句区分不开」
        # —— 那是错误的合并理由：cut「切割」与 cut「执行」是两个概念，
        # 只是共用词形。「造不出区分句」是造句阶段该花功夫，不是词库该砍义项。
        soft_note = ""
        if soft and len(rows) > soft:
            soft_note = ("[告警] 产出 %d 义项 > %d（%s 词的义项数反常，"
                         "值得确认是否都是独立概念）"
                         % (len(rows), soft, load_tier(w) or "?"))
        # ── 义项间重复守卫 ───────────────────────────────
        # 同词的义项不得共享同一条英文释义。这直接对应「重复卡片」——
        # glossEn 雷同、例句必然雷同，例句审计查不出来（它只查搭配一致性）。
        # 真实成因几乎都是 decisions 把 fromZh 写成了 fromLines（词库侧没错，
        # 是决策文件把两个不同义项挂到同一条边界上），所以要在 build 期拦住。
        _seen_gloss = {}
        for r in rows:
            k = _gloss_key(r["glossEn"])
            if k and k in _seen_gloss:
                bad.append("s%s 与 %s 的英文释义完全相同（%s）"
                           % (r["senseId"], _seen_gloss[k], k[:44]))
            elif k:
                _seen_gloss[k] = r["senseId"]
        if bad:
            print("  [跳过] %-12s %s" % (w, "; ".join(bad)))
            continue
        if dry:
            print("  [dry] %-12s %d 义项（未写入）" % (w, len(rows)))
            for r in rows:
                print("        %s [%-4s] %s  <=  %s"
                      % (r["senseId"], r["pos"], r["glossZh"], r["glossEn"][:70]))
            continue
        if not os.path.isdir(out_dir):
            os.makedirs(out_dir)
        p = os.path.join(out_dir, w + ".tsv")
        with io.open(p, "w", encoding="utf-8", newline="") as fh:
            wr = csv.DictWriter(
                fh, fieldnames=["senseId", "pos", "glossZh", "glossEn",
                                "trap", "tier", "note"],
                delimiter="\t", lineterminator="\n")
            wr.writeheader()
            wr.writerows(rows)
        built += 1
        total_senses += len(rows)
    print("\n写出 %d 词 / %d 义项 -> %s" % (built, total_senses, cfg["out_dir"]))
    print("\n写出 %d 词 / %d 义项 -> %s" % (built, total_senses, cfg["out_dir"]))
    if missing:
        print("无 decisions 未处理 %d 词（如需处理请先写 decisions）" % len(missing))


def cmd_handoff(cfg, snap, words):
    """生成「待填决策」骨架 + 每词的完整上下文，供外部 AI（或人）填写。

    为什么要这个：切分与翻译是**语义判断**，不能进代码（README 铁律 2）。
    2927 个词靠对话里逐个做不现实，需要能并行交给多个 AI。
    本命令产出两份东西：
      1. data/senses_v2/decisions/<word>.json   骨架（含必须填的空位与约束）
      2. 标准输出打印该词的全部输入上下文，直接贴给 AI 即可

    **骨架只在文件不存在时创建**，绝不覆盖已有决策 —— 否则会把人工/AI 的
    劳动清空。已存在的词会在输出里提示「已有决策，跳过」。
    """
    out_dir = os.path.join(KIT, cfg["decisions_dir"])
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    created = skipped = 0
    for w in words or [x for x, _ in load_core()]:
        if w in active_skip(cfg):
            continue
        p = os.path.join(out_dir, w + ".json")
        if os.path.exists(p):
            skipped += 1
            continue
        kept, dropped = english_units(w, snap, cfg)
        old = zh_units(w)
        if not kept and not old:
            continue
        skeleton = {
            "_comment": "填 senses 与 _oldSenses 两个字段即可。"
                        "规则见 docs/decisions/D18 与本文件的 _rules。",
            "word": w,
            "senses": [
                {
                    "_raw": "int=英文边界行号；[\"wn\",i]=WordNet 补缺项；"
                            "省略=纯中文补洞(fromZh)",
                    "fromLines": [],
                    "fromZh": [],
                    "pos": "",
                    "glossZh": "",
                    "note": "",
                }
            ],
            "_oldSenses": [
                {"oldSenseIndex": 0, "oldGlossZh": "",
                 "action": "merged", "into": "v2 s1", "reason": ""}
            ],
            "_rules": {
                "边界": "以 E 编号为准，一条英文释义 = 一个义位。"
                        "同义的几条要合并进同一个 fromLines。",
                "glossZh": "按英文义项重新翻译，不要沿用现有中文的切法。",
                "fromZh": "现有中文义项里英文侧没有对应释义的，走这里保留"
                          "（下标用 [3] 里的数字，不要猜）。",
                "_oldSenses": "现有每个中文义项的下标必须出现且仅出现一次："
                              "被 fromZh 接住就不再列；被并入某义项就写 "
                              "action=merged 并给 into/reason。",
                "禁止": "不得因为「英文侧没收录」就删义项 —— 那是词典覆盖问题，"
                        "不是这个意思不存在。",
            },
        }
        with io.open(p, "w", encoding="utf-8") as fh:
            json.dump(skeleton, fh, ensure_ascii=False, indent=2)
        created += 1
        print("=" * 70)
        print("### %s   (%s, 英文边界 %d, 现有中文义项 %d)"
              % (w, load_tier(w) or "?", len(kept), len(old)))
        print("\n[英文边界 —— 切分的真相源]")
        for i, u in enumerate(kept):
            tag = "  <-WORDNET 补缺" if u["from"] == "WORDNET" else ""
            print("  E%d [%-4s]%s %s" % (i, u["pos"] or "?", tag, u["body"]))
        if dropped:
            print("\n[已清洗，不要再用]")
            for d in dropped:
                print("  --%s: %s" % (d["why"], d["body"][:70]))
        print("\n[现有中文义项 —— 每个都必须在 _oldSenses 里交代去向]")
        for pos, zh, idx in old:
            print("  [%d] [%-4s] %s" % (idx, pos or "?", zh))
        sep = separability_flags(cfg, w, kept)
        if sep:
            print("\n[疑似同义 —— 需你判断是否合并]")
            for i, j, sim in sep:
                print("  %.2f  E%d %s" % (sim, i, kept[i]["body"][:64]))
                print("        E%d %s" % (j, kept[j]["body"][:64]))
        soft = soft_cap()
        if soft and len(kept) > soft:
            print("\n[注意] 边界 %d 超过软阈值 %d —— WordNet 把细微用法都列出来了，"
                  "需要合并到可判别的义项，并在 _mergeNote 说明依据"
                  % (len(kept), soft))
        fb = missing_pos_units(w, kept)
        if fb:
            print("\n[英文零覆盖的词性 —— 需从现有中文义项补]")
            for pos, zh, idx in fb:
                print("  Z%d [%-4s] %s" % (idx, pos or "?", zh))
        print("\n[骨架已写入] %s" % os.path.relpath(p, KIT))
    print("\n生成骨架 %d 词，跳过已有 %d 词" % (created, skipped))


def cmd_report(cfg, words):
    """v2 vs 现有 wordlist/senses 的差异。纯读。"""
    out_dir = os.path.join(KIT, cfg["out_dir"])
    targets = words or sorted(f[:-4] for f in os.listdir(out_dir)
                              if f.endswith(".tsv"))
    print("=" * 70)
    print("v2 vs 现有差异报告（只读，不改任何文件）")
    print("=" * 70)
    same = 0
    diff = []
    for w in targets:
        new_p = os.path.join(out_dir, w + ".tsv")
        old_p = os.path.join(OLD_SE, w + ".tsv")
        if not os.path.exists(new_p):
            continue
        new = list(csv.DictReader(io.open(new_p, encoding="utf-8"), delimiter="\t"))
        old = (list(csv.DictReader(io.open(old_p, encoding="utf-8"), delimiter="\t"))
               if os.path.exists(old_p) else [])
        old_zh = [r["glossZh"] for r in old]
        new_zh = [r["glossZh"] for r in new]
        if old_zh == new_zh:
            same += 1
            continue
        diff.append((w, old, new))
    print("\n完全一致（义项数与顺序、中文释义全同）: %d 词" % same)
    print("有差异: %d 词\n" % len(diff))
    for w, old, new in diff:
        print("--- %s" % w)
        print("    现有(%d): %s" % (len(old), " / ".join(
            "%s[%s]%s" % (r["senseId"], r["pos"], r["glossZh"]) for r in old)))
        print("    v2  (%d): %s" % (len(new), " / ".join(
            "%s[%s]%s" % (r["senseId"], r["pos"], r["glossZh"]) for r in new)))
        print()


def cmd_synset(words):
    """查 synset 真实名字。**写 decisions 前必须先查，不要猜。**

    教训：sharp 的首词 synset 是 a.08 起（a.09/a.10/s.08/s.09），
    猜 a.01/a.02 会让 fromLines 静默失效 —— 报错只说「已被清洗掉的
    英文行」，指向不了「名字猜错」。

    `--synset sharp`                     列本词全部首词 synset（含被过滤的）
    `--synset sharp having or made by`  按释义片段反查名字
    """
    wn = wordnet_roots()
    if wn is None:
        print("WordNet 不可用")
        return
    word = words[0]
    extra = words[1:]
    frag = " ".join(extra).lower()
    print("=== %s%s" % (word, "  片段=%r" % frag if frag else ""))
    for s in first_word_synsets(word, wn, exceptions_for(word)):
        body = s.definition().strip()
        if frag and frag not in body.lower():
            continue
        ud = [d.name() for d in s.usage_domains()]
        flags = []
        if s.lexname() in _drop_lexnames():
            flags.append("lexname=" + s.lexname())
        if ud and any(d in _drop_usage() for d in ud):
            flags.append("usage=" + ",".join(ud))
        if len(body.split()) < int(_supplement_cfg().get("min_en_words", 3)):
            flags.append("too_short")
        print("  %-16s [%-5s] %-9s %s%s" % (
            s.name(), s.pos() + ".", s.lexname(), body[:66],
            ("   <被过滤: " + ";".join(flags) + ">") if flags else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", nargs="*", help="列出英文边界（不给词=全库统计）")
    ap.add_argument("--build", nargs="*", help="套用 decisions 产出 v2 TSV")
    ap.add_argument("--handoff", nargs="*",
                    help="给外部 AI 的施工单：每词一个决策文件（人或别的模型填）")
    ap.add_argument("--report", nargs="*", help="v2 vs 现有差异")
    ap.add_argument("--synset", nargs="+", metavar="ARG",
                    help="查 synset 真实名字（写 decisions 前必查，别猜）")
    ap.add_argument("--dry", action="store_true", help="--build 只打印不写文件")
    a = ap.parse_args()
    cfg = load_spec()
    if a.plan is not None:
        snap = load_snapshot(cfg)
        cmd_plan(cfg, snap, a.plan)
    elif a.build is not None:
        snap = load_snapshot(cfg)
        cmd_build(cfg, snap, a.build, dry=a.dry)
    elif a.handoff is not None:
        snap = load_snapshot(cfg)
        cmd_handoff(cfg, snap, a.handoff)
    elif a.synset is not None:
        cmd_synset(a.synset)
    elif a.report is not None:
        cmd_report(cfg, a.report)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()