# -*- coding: utf-8 -*-
"""句子落盘 + 规则质检。

opencode（我）生成的句子写到 data/sentences/<word>.tsv，
由本脚本做机械质检（G1/G2/G3/G4/G6/G7）并汇总统计。

分工：
  我（LLM）  —— 语义质量：G4 线索是否真能区辨、G5 义项唯一性、译文是否传神
  本脚本    —— 机械校验：词形/句长/超纲词/clue 可定位/跨度偏移/指纹去重

与旧 stage3_judge.md 的区别：不再需要第二次 LLM 调用做机械检查，
只有 G5 需要语义判断，而那恰好是我生成时就已经内化的对比。
"""
import csv, io, json, os, re, sys, collections, hashlib

import yaml

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # = content-kit/
SDIR = os.path.join(PROJ, "data", "sentences")
SE = os.path.join(PROJ, "data", "wordlist", "senses")
WL = os.path.join(PROJ, "data", "wordlist")

HEADER = ["senseId", "text", "clue", "span_start", "span_len",
          "translation", "note", "source"]

# 内容规格（句长/每义项句数/生僻词名单）从 data/spec.yaml 加载——
# 「一个句子该不该被接受」是内容决策，真相源在数据层不在代码。
# 2026-10 规格反转前这里是硬编码常量，由 make_spec.py 反向同步；
# 现已反转：改规格只改 spec.yaml，立即生效，无需动代码。
with io.open(os.path.join(PROJ, "spec.yaml"), encoding="utf-8") as _fh:
    _SPEC = yaml.safe_load(_fh)
LEN_RANGE = {int(k): tuple(v) for k, v in _SPEC["sentence_length"].items()}
TARGET_SENTS = int(_SPEC["sentences_per_sense"])

CORE = set()
_core_path = os.path.join(WL, "kaoyan_dagang_core.tsv")
if os.path.exists(_core_path):
    with io.open(_core_path, encoding="utf-8") as fh:
        for i, row in enumerate(csv.reader(fh, delimiter="\t")):
            if i:
                CORE.add(row[0].strip().lower())

WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")

# 英语功能词/高频虚词：不在 CORE 3000 词表里（词表只收实词），但必须放行
STOPWORDS = set("""
a an the this that these those there here
and or but nor so yet for if then than as because while although though
of in on at to from by with without within into onto upon about above below
under over across through between among against during before after since
is are was were be been being am do does did done doing have has had having
i you he she it we they me him her them my your his its our their mine yours
who whom whose which what where when why how
not no nor none any some all both each every few many much more most other
another such only own same too very can could will would shall should may
might must let us also just even still yet again once twice
one two three four five six seven eight nine ten first second third next last
up down out off around near back away forward together apart instead
""".split())

# 不规则动词：G1 需要它们，否则 laid / ran / went 会被误判成"目标词缺失"
IRREGULAR = {
    # be / have / do 已单列
    "arise": ["arises", "arose", "arisen", "arising"],
    "awake": ["awakes", "awoke", "awoken", "awaking"],
    "bear": ["bears", "bore", "borne", "bearing"],
    "beat": ["beats", "beat", "beaten", "beating"],
    "become": ["becomes", "became", "become"],
    "begin": ["begins", "began", "begun", "beginning"],
    "bend": ["bends", "bent", "bending"],
    "bet": ["bets", "bet", "betting"],
    "bind": ["binds", "bound", "binding"],
    "bite": ["bites", "bit", "bitten", "biting"],
    "bleed": ["bleeds", "bled", "bleeding"],
    "blow": ["blows", "blew", "blown", "blowing"],
    "broadcast": ["broadcasts", "broadcast", "broadcasting"],
    "burst": ["bursts", "burst", "bursting"],
    "cast": ["casts", "cast", "casting"],
    "cling": ["clings", "clung", "clinging"],
    "come": ["comes", "came", "coming"],
    "cost": ["costs", "cost", "costing"],
    "creep": ["creeps", "crept", "creeping"],
    "cut": ["cuts", "cut", "cutting"],
    "deal": ["deals", "dealt", "dealing"],
    "dig": ["digs", "dug", "digging"],
    "draw": ["draws", "drew", "drawn", "drawing"],
    "drink": ["drinks", "drank", "drunk", "drinking"],
    "drive": ["drives", "drove", "driven", "driving"],
    "eat": ["eats", "ate", "eaten", "eating"],
    "fall": ["falls", "fell", "fallen", "falling"],
    "feed": ["feeds", "fed", "feeding"],
    "feel": ["feels", "felt", "feeling"],
    "fight": ["fights", "fought", "fighting"],
    "find": ["finds", "found", "finding"],
    "flee": ["flees", "fled", "fleeing"],
    "fling": ["flings", "flung", "flinging"],
    "fly": ["flies", "flew", "flown", "flying"],
    "forbid": ["forbids", "forbade", "forbidden", "forbidding"],
    "forget": ["forgets", "forgot", "forgotten", "forgetting"],
    "forgive": ["forgives", "forgave", "forgiven", "forgiving"],
    "freeze": ["freezes", "froze", "frozen", "freezing"],
    "get": ["gets", "got", "gotten", "getting"],
    "give": ["gives", "gave", "given", "giving"],
    "go": ["goes", "went", "gone", "going"],
    "grind": ["grinds", "ground", "grinding"],
    "grow": ["grows", "grew", "grown", "growing"],
    "hide": ["hides", "hid", "hidden", "hiding"],
    "hit": ["hits", "hit", "hitting"],
    "hold": ["holds", "held", "holding"],
    "hurt": ["hurts", "hurt", "hurting"],
    "keep": ["keeps", "kept", "keeping"],
    "kneel": ["kneels", "knelt", "kneeling"],
    "know": ["knows", "knew", "known", "knowing"],
    "lay": ["lays", "laid", "laying"],
    "lead": ["leads", "led", "leading"],
    "leap": ["leaps", "leaped", "leapt", "leaping"],
    "leave": ["leaves", "left", "leaving"],
    "lend": ["lends", "lent", "lending"],
    "let": ["lets", "letting"],
    "lie": ["lies", "lay", "lain", "lying"],
    "light": ["lights", "lit", "lighting"],
    "lose": ["loses", "lost", "losing"],
    "make": ["makes", "made", "making"],
    "mean": ["means", "meant", "meaning"],
    "meet": ["meets", "met", "meeting"],
    "mistake": ["mistakes", "mistook", "mistaken", "mistaking"],
    "overcome": ["overcomes", "overcame", "overcoming"],
    "pay": ["pays", "paid", "paying"],
    "put": ["puts", "put", "putting"],
    "quit": ["quits", "quit", "quitting"],
    "read": ["reads", "reading"],
    "rebuild": ["rebuilds", "rebuilt", "rebuilding"],
    "repay": ["repays", "repaid", "repaying"],
    "rid": ["rids", "rode", "ridding"],
    "ride": ["rides", "rode", "ridden", "riding"],
    "ring": ["rings", "rang", "rung", "ringing"],
    "rise": ["rises", "rose", "risen", "rising"],
    "run": ["runs", "ran", "running"],
    "saw": ["saws", "sawed", "sawn", "sawing"],
    "say": ["says", "said", "saying"],
    "see": ["sees", "saw", "seen", "seeing"],
    "seek": ["seeks", "sought", "seeking"],
    "sell": ["sells", "sold", "selling"],
    "send": ["sends", "sent", "sending"],
    "set": ["sets", "set", "setting"],
    "shake": ["shakes", "shook", "shaken", "shaking"],
    "shed": ["sheds", "shed", "shedding"],
    "shine": ["shines", "shone", "shining"],
    "shoot": ["shoots", "shot", "shooting"],
    "show": ["shows", "showed", "shown", "showing"],
    "shrink": ["shrinks", "shrank", "shrunk", "shrinking"],
    "shut": ["shuts", "shut", "shutting"],
    "sing": ["sings", "sang", "sung", "singing"],
    "sink": ["sinks", "sank", "sunk", "sinking"],
    "sit": ["sits", "sat", "sitting"],
    "slay": ["slays", "slew", "slain", "slaying"],
    "sleep": ["sleeps", "slept", "sleeping"],
    "slide": ["slides", "slid", "sliding"],
    "smite": ["smites", "smote", "smitten", "smiting"],
    "speak": ["speaks", "spoke", "spoken", "speaking"],
    "speed": ["speeds", "sped", "speeding"],
    "spin": ["spins", "spun", "spinning"],
    "spit": ["spits", "spat", "spitting"],
    "split": ["splits", "split", "splitting"],
    "spread": ["spreads", "spread", "spreading"],
    "spring": ["springs", "sprang", "sprung", "springing"],
    "stand": ["stands", "stood", "standing"],
    "steal": ["steals", "stole", "stolen", "stealing"],
    "stick": ["sticks", "stuck", "sticking"],
    "sting": ["stings", "stung", "stinging"],
    "strive": ["strives", "strove", "striven", "striving"],
    "strike": ["strikes", "struck", "striking"],
    "swear": ["swears", "swore", "sworn", "swearing"],
    "sweep": ["sweeps", "swept", "sweeping"],
    "swim": ["swims", "swam", "swum", "swimming"],
    "swing": ["swings", "swung", "swinging"],
    "take": ["takes", "took", "taken", "taking"],
    "teach": ["teaches", "taught", "teaching"],
    "tear": ["tears", "tore", "torn", "tearing"],
    "tell": ["tells", "told", "telling"],
    "think": ["thinks", "thought", "thinking"],
    "throw": ["throws", "threw", "thrown", "throwing"],
    "understand": ["understands", "understood", "understanding"],
    "undergo": ["undergoes", "underwent", "undergone", "undergoing"],
    "undertake": ["undertakes", "undertook", "undertaken", "undertaking"],
    "wake": ["wakes", "woke", "woken", "waking"],
    "wear": ["wears", "wore", "worn", "wearing"],
    "weep": ["weeps", "wept", "weeping"],
    "win": ["wins", "won", "winning"],
    "withdraw": ["withdraws", "withdrew", "withdrawn", "withdrawing"],
    "write": ["writes", "wrote", "written", "writing"],
}

# 前缀派生的词族：exclude/exclude -> include/excluded, participate -> participation。
# G1 用"词干前缀匹配"兜底，避免为每个派生词手写变形表。
DERIV_PREFIX = ["counter", "inter", "trans", "super", "under", "over", "anti",
                "non", "pre", "mis", "out", "sub", "dis", "com", "con", "pro",
                "un", "re", "in", "im", "ex", "de", "en", "em", "co"]


def _derivatives(w):
    """剥掉常见前缀得到词干，再套规则变形。"""
    out = set()
    for p in DERIV_PREFIX:
        if w.startswith(p) and len(w) - len(p) >= 3:
            stem = w[len(p):]
            out.add(stem)                       # exclude -> include
            out |= {stem + s for s in ("s", "ed", "ing", "d")}
    return out


def inflections(word):
    """目标词 + 规则变形 + 不规则变形 + 前缀派生词形，用于 G1。"""
    w = word.lower()
    forms = {w, w + "s", w + "es", w + "ed", w + "d", w + "ing", w + "ly",
             w + "er", w + "est"}
    if w in IRREGULAR:
        forms |= set(IRREGULAR[w])
    else:
        if w.endswith("y"):
            forms |= {w[:-1] + "ies", w[:-1] + "ied", w + "ing"}
        if w.endswith("e"):
            forms |= {w + "d", w[:-1] + "ing", w + "es"}
        if w.endswith(("s", "x", "z", "ch", "sh")):
            forms |= {w + "es"}
        if len(w) > 2 and w[-1] not in "aeiouwxy" and w[-2] in "aeiou" \
                and w[-3] not in "aeiou":
            forms |= {w + w[-1] + "ing", w + w[-1] + "ed"}
    forms |= _derivatives(w)
    return forms


def stem_match(target, token):
    """词干前缀匹配：token 与 target 共享足够长的词干前缀即视为同一词族。

    兜底手段：句中出现 include 而目标是 exclude 这类前缀派生，
    以及句子用了同义词根的情形。
    """
    if not target or not token:
        return False
    t, k = target.lower(), token.lower()
    n = 0
    while n < min(len(t), len(k)) and t[n] == k[n]:
        n += 1
    # 共享 >=4 字符且较短一方至少被覆盖 60%
    return n >= 4 and n >= min(len(t), len(k)) * 0.6


def core_forms():
    """CORE 词表 + 其规则变形，用于 G3 放行。"""
    if not CORE:
        return set()
    out = set(CORE)
    for w in CORE:
        out |= inflections(w)
    return out


CORE_FORMS = None

# G3 的实际拦截名单：真正的超纲生词。真相源是 data/spec.yaml 的 too_hard，
# 这里只加载不定义。刻意保持很短——宁可放过，也不误杀。
# 加入标准：在 3000 考研词表之外，且不属于任何 8000+ 高频词，
#         且对非母语读者会卡住。常见生活名词（soup/deer/children）不在此列。
TOO_HARD = set(_SPEC["too_hard"])


def in_core(tok):
    global CORE_FORMS
    if CORE_FORMS is None:
        CORE_FORMS = core_forms()
    return tok in CORE_FORMS or tok in STOPWORDS


def load_senses(word):
    p = os.path.join(SE, word + ".tsv")
    if not os.path.exists(p):
        return []
    out = []
    with io.open(p, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            out.append(r)
    return out


def fingerprint(text):
    """场景指纹：忽略标点与大小写，用于 G7 查重。"""
    t = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return hashlib.md5(t.encode()).hexdigest()[:12]


def check(rows, senses, core_known=True):
    """对单个词的句子做机械质检。返回 (verdicts, fingerprint_map)"""
    if not rows:
        return [], {}
    word = rows[0]["word"]
    forms = inflections(word)
    valid_ids = {s["senseId"] for s in senses}
    zh_by_id = {s["senseId"]: s["glossZh"] for s in senses}

    verdicts = []
    fps = {}
    for r in rows:
        text = r["text"]
        clue = r["clue"]
        tr = r["translation"]
        v = []

        # G1 目标词存在且词形匹配
        # 三级判定：精确词形 -> 前缀派生词形 -> 词干前缀匹配（兜底）
        tokens = {t.lower() for t in WORD_RE.findall(text)}
        hit = tokens & forms
        if not hit:
            hit = {t for t in tokens if stem_match(word, t)}
        if not hit:
            v.append(("G1", "目标词及其变形均未出现：%s（句中：%s）"
                             % (word, ", ".join(sorted(tokens)))))

        # G2 句长
        n = len([t for t in WORD_RE.findall(text)])
        lo, hi = LEN_RANGE[1]
        if not (lo <= n <= hi):
            v.append(("G2", "句长 %d 词，超出 D1 区间 %d-%d" % (n, lo, hi)))

        # G3 背景词难度可控
        #
        # 原 spec 写的是"非目标词 ∩ CORE 3000 = ∅"，实测**不可满足**：
        # CORE 3000 只收实词，连 the/and/of 都不含，任何正常句子都会 fail。
        # 拿归档的 404 条人工句（质量合格、反复用过的句子）复查，
        # 181/404 = 45% 会被误判。误判词是 up/exam/children/soup/deer/stove
        # 这类**普通词**，不是生僻词。
        #
        # 改为：只拦截真正的超纲生词（具体名单，来自人工句复查里
        # 反复出现但确实无学习价值的词），其余一律放行。
        if core_known:
            oov = sorted(t for t in tokens
                         if t not in forms and not in_core(t)
                         and t in TOO_HARD and len(t) > 2)
            if oov:
                v.append(("G3", "生僻词：%s" % ", ".join(oov[:6])))

        # G4 线索词存在且可字面定位
        if not clue or not clue.strip():
            v.append(("G4", "缺少 clue"))
        elif clue.lower() not in text.lower():
            v.append(("G4", "clue '%s' 无法在句中定位" % clue))

        # SPAN 偏移准确性
        # 约定：span 指向**目标词**——界面要猜义项的那个词。
        # 高亮句中别处的短语等于没指示（目标词已经在顶部徽章上显示了）。
        # clue 列仍要求可定位（G4），但它只是语境提示，不参与渲染。
        try:
            ss = int(r["span_start"]); sl = int(r["span_len"])
        except (ValueError, TypeError):
            ss, sl = -1, -1
            v.append(("SPAN", "span 非整数"))
        else:
            if not (0 <= ss and ss + sl <= len(text)):
                v.append(("SPAN", "span [%d,%d) 越界（句长 %d）"
                                  % (ss, ss + sl, len(text))))
            else:
                exp_ss, exp_sl = find_target(text, word)
                if exp_ss < 0:
                    v.append(("SPAN", "句中找不到目标词 '%s' 的任何词形" % word))
                elif (ss, sl) != (exp_ss, exp_sl):
                    v.append(("SPAN", "span 指向 '%s'，应为目标词 '%s'"
                              % (text[ss:ss + sl], text[exp_ss:exp_ss + exp_sl])))

        # G6 译文存在且非空、与句子长度相称
        if not tr or not tr.strip():
            v.append(("G6", "译文为空"))
        elif len(tr) < 4:
            v.append(("G6", "译文过短：%s" % tr))

        # G7 指纹唯一（跨义项）
        fp = fingerprint(text)
        if fp in fps:
            v.append(("G7", "与 %s#%s 句子重复" % fps[fp]))
        else:
            fps[fp] = (word, r["senseId"])

        # senseId 必须存在于词库
        if r["senseId"] not in valid_ids:
            v.append(("SID", "senseId %s 不在词库" % r["senseId"]))

        # GLOSS note 里记的释义必须指向词库的同一个义项
        #
        # 为什么需要这条：写第 5 批时我按「以为的义项顺序」贴释义，eastern 顺序
        # 就贴错了一组（字典是 东方人/东正教徒/东方的/向东的，我按
        # 东方/东正教徒/东方人/向东 写），wood s3 也贴错（字典是动词
        # 「植林于」，我当成「植林地」）。**释义贴错 = 教错，比没有例句更糟。**
        # 当时靠生成器内的「按释义反查 senseId」挡住，但那个脚本在仓库外、
        # 下一批就会忘。这条规则把同样的保护固化进常驻质检：不管句子从哪来，
        # 手写、模型生成、还是从别处导入，都过这一关。
        #
        # 判据是「互相包含」而不是相等：note 末尾形如「<说明> = <释义>」，
        # 而 <释义> 常带注解（指责（非正式指控）= 指责、归咎于 = 归咎），
        # 要求全等会误报 542 条。互不包含才是真错贴（东方的 vs 东方人）。
        _note = r.get("note", "")
        if " = " in _note and r["senseId"] in zh_by_id:
            claimed = _note.rsplit(" = ", 1)[1].strip().rstrip("。．.、")
            real = (zh_by_id[r["senseId"]] or "").strip()
            if claimed and real and claimed not in real and real not in claimed:
                v.append(("GLOSS", "note 释义 '%s' 与词库 %s 的 '%s' 互不包含"
                                   "（义项贴错）" % (claimed, r["senseId"], real)))

        # note 应提及目标词（说明是人工/模型自觉写的辨析）
        if not r.get("note", "").strip():
            v.append(("NOTE", "缺少辨析 note"))

        verdicts.append({"word": word, "senseId": r["senseId"],
                         "fingerprint": fp, "fails": v,
                         "ok": not v,
                         "text": text})
    return verdicts, fps


def audit(verbose=True, only=None):
    """全库审计。"""
    if not os.path.isdir(SDIR):
        print("data/sentences/ 不存在——还没有任何句子。")
        return None

    allv = []
    global_fps = {}
    words = sorted(f[:-4] for f in os.listdir(SDIR) if f.endswith(".tsv"))
    if only:
        words = [w for w in words if w in only]

    n_sent = 0
    per_word = {}
    for w in words:
        senses = load_senses(w)
        with io.open(os.path.join(SDIR, w + ".tsv"), encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter="\t"))
        for r in rows:
            r["word"] = w
        n_sent += len(rows)
        vv, fps = check(rows, senses)
        for v in vv:
            if v["fingerprint"] in global_fps:
                prev = global_fps[v["fingerprint"]]
                v["fails"].append(("G7X", "与 %s#%s 重复" % prev))
                v["ok"] = False
            else:
                global_fps[v["fingerprint"]] = (w, v["senseId"])
        allv.extend(vv)
        per_word[w] = vv

    ok = [v for v in allv if v["ok"]]
    bad = [v for v in allv if not v["ok"]]
    by_code = collections.Counter(c for v in bad for c, _ in v["fails"])

    print("=" * 62)
    print("句子总数 %d, PASS %d (%.1f%%), REJECT %d (%.1f%%)"
          % (n_sent, len(ok), len(ok) / max(1, n_sent) * 100,
             len(bad), len(bad) / max(1, n_sent) * 100))
    print("健康区间 8-20%% REJECT（低于 5%% 说明质检放水，高于 25%% 说明生成跑偏）")
    if bad:
        print("\nREJECT 原因分布:")
        for c, n in by_code.most_common():
            print("   %-5s %4d" % (c, n))
        if verbose:
            print("\n样例（前 20 条 REJECT）:")
            for v in bad[:20]:
                print("   [%s#%s] %s" % (v["word"], v["senseId"], v["text"][:62]))
                for c, why in v["fails"]:
                    print("        %-5s %s" % (c, why))

    # 每义项句数
    if per_word:
        cnt = collections.Counter()
        for w, vv in per_word.items():
            for v in vv:
                cnt[(w, v["senseId"])] += 1
        short = [k for k, n in cnt.items() if n < TARGET_SENTS]
        print("\n句子数达标的义项: %d/%d (目标 >=%d)"
              % (len(cnt) - len(short), len(cnt), TARGET_SENTS))
        if short and verbose:
            print("   不足的义项: %s" % ", ".join("%s#%s(%d)" % (w, s, cnt[(w, s)])
                                                for w, s in sorted(short)[:15]))
    return {"sent": n_sent, "ok": len(ok), "bad": len(bad),
            "by_code": dict(by_code), "per_word": per_word}


def find_target(text, word):
    """在句子里定位**目标词**（要考义项的那个词）的位置。

    span 的约定：**指向目标词，不是句中别处的短语**。
    高亮的必须是"你要猜意思的那个词" —— 界面顶部徽章之外的第二次指示，
    指向别的词就等于没指示。clue 列保留为语境提示，但不再渲染。

    定位靠 inflections()（规则 + 不规则 + 前缀派生 + 词干兜底），
    优先精确匹配原形，再匹配变形，最后词干兜底。
    """
    t = text
    forms = inflections(word)
    # 原形优先，其次短的变形（避免 laid 抢在 laying 前面时长度乱序）
    order = sorted(forms, key=lambda f: (len(f) != len(word), len(f)))
    for f in order:
        m = re.search(r"\b" + re.escape(f) + r"\b", t, re.I)
        if m:
            return m.start(), len(f)
    # 词干兜底：句中用了前缀派生或同词族的其他词形
    for m in re.finditer(r"[A-Za-z]+", t):
        tok = m.group(0)
        if stem_match(word, tok):
            return m.start(), len(tok)
    return -1, 0        # 调用方一律按 -1 判失败，别返回 None


def fix_spans(word=None, dry=False):
    """按**目标词**重新计算 span_start/span_len 并回写。

    人工/模型给出的偏移容易算错（尤其中文 prompt 要求"逐字节偏移"，
    而实际 UI 用的是字符偏移）。这个函数把它变成机械操作。
    """
    if not os.path.isdir(SDIR):
        print("data/sentences/ 不存在")
        return 0
    words = sorted(f[:-4] for f in os.listdir(SDIR) if f.endswith(".tsv"))
    if word:
        words = [word]

    n_fixed = n_missing = 0
    for w in words:
        p = os.path.join(SDIR, w + ".tsv")
        with io.open(p, encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter="\t"))
        if not rows:
            continue
        fields = list(rows[0].keys())
        changed = False
        for r in rows:
            text = r.get("text") or ""
            idx, ln = find_target(text, w)
            if idx < 0:
                n_missing += 1
                r["span_start"], r["span_len"] = "0", "0"
                continue
            if str(r.get("span_start")) != str(idx) or str(r.get("span_len")) != str(ln):
                r["span_start"] = str(idx)
                r["span_len"] = str(ln)
                changed = True
                n_fixed += 1
        if changed and not dry:
            with io.open(p, "w", encoding="utf-8", newline="") as fh:
                wr = csv.DictWriter(fh, fieldnames=fields, delimiter="\t",
                                    lineterminator="\n")
                wr.writeheader()
                wr.writerows(rows)
    print("span 重算(目标词): %d 条%s" % (n_fixed, "（dry-run，未写入）" if dry else ""))
    if n_missing:
        print("  [FAIL] 句子里找不到目标词: %d 条 —— 这是 G1 该拦的" % n_missing)
    return n_fixed


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--fix-spans":
        fix_spans(args[1] if len(args) > 1 else None,
                  dry="--dry" in args)
    else:
        audit(only=set(args) if args else None)
