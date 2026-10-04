# -*- coding: utf-8 -*-
"""生成 data/wordlist/ipa.tsv —— 每个词的音标。

来源 CMUdict（CMU 发音词典，免费离线，126052 词条），ARPAbet 转 IPA。
不花钱、不联网、不调用任何服务。

    python scripts/build_ipa.py

**多读音词按词性选读音**（read / live / lead / wind / conduct…）：
CMUdict 对兼类词的排列是「名词读音在前、动词读音在后」。取第一个会把
read 教成 /ɹɛd/、live 教成 /lɪv/ —— 教错读音比不教更糟。
"""
import csv, io, json, os, re, sys

sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
B = os.path.join(PROJ, "build", "intermediate", "ecdict_senses_b.json")
OUT = os.path.join(PROJ, "data", "wordlist", "ipa.tsv")

ARPABET = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "EH": "ɛ", "ER": "ɜɹ",
    "EY": "eɪ", "F": "f", "G": "ɡ", "HH": "h", "IH": "ɪ", "IY": "i",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ",
    "OW": "oʊ", "OY": "ɔɪ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ",
    "T": "t", "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
    # UH / UW 必须有：CMUdict 里 UW 是最高频元音之一（go / do / blue / through）。
    # 漏了它，200 个词的音标会整个丢掉那个元音 —— studio 变成「stdiˌoʊ」。
    "UH": "ʊ", "UX": "ʌ", "UW": "u",
}
VOWELS = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY",
          "IH", "IY", "OW", "OY", "UH", "UW", "UX"}
# AH0 多数词读 ə，少数（BUT/HUT）读 ʌ。统一用 ə，更常见。
SCHWA = {"AH0": "ə"}
VERB_POS = {"v", "vt", "vi"}

# 美式词典里没有的英式拼写
FALLBACK = {"enrol": "enroll", "practise": "practice", "travelling": "traveling",
            "cancelled": "canceled", "centre": "center", "colour": "color",
            "grey": "gray", "organise": "organize", "realise": "realize",
            "recognise": "recognize", "analyse": "analyze",
            "behaviour": "behavior", "favour": "favor", "labour": "labor",
            "neighbour": "neighbor", "programme": "program",
            "defence": "defense", "licence": "license",
            "catalogue": "catalog", "dialogue": "dialog",
            "metre": "meter", "litre": "liter", "theatre": "theater",
            "woollen": "woolen", "travelled": "traveled", "traveller": "traveler",
            "counsellor": "counselor", "marvellous": "marvelous",
            "judgement": "judgment", "storey": "story",
            "plough": "plow", "mould": "mold", "smoulder": "smolder"}


def split_phoneme(ph):
    """'EY1' -> ('EY', '1')；'L' -> ('L', '0')。只砍掉最后一位重音数字。"""
    m = re.match(r"^([A-Z]+)([0-2])?$", ph)
    if not m:
        return ph, "0"
    return m.group(1), m.group(2) or "0"


def phones_to_ipa(phones):
    """一组 ARPAbet 音素 -> IPA 串。

    只做两件事：逐个映射 + 标重音。
    **不要在字符之间插空格** —— 早先写了 " ".join(str)，那是按字符 join，
    lay 会变成「ˈ e ɪ」，连 l 都丢了；enrol 变成「ˈ o ʊ l」。
    """
    out = []
    for ph in phones:
        base, stress = split_phoneme(ph)
        sym = SCHWA.get(ph) or ARPABET.get(base)
        if sym is None:
            continue
        if base in VOWELS and stress == "1":
            out.append("ˈ" + sym)
        elif base in VOWELS and stress == "2":
            out.append("ˌ" + sym)
        else:
            out.append(sym)
    return "".join(out)


def pick_by_pos(variants, pos):
    """多读音时按词性选。

    CMUdict 对兼类词的排列是「名词读音在前、动词读音在后」
    （read: EH1D -> IY1D；live: AY1V -> IH1V；conduct: ˈɑndʌkt -> ənˈdʌkt）。

    **不要靠重音位置判断**：read 的两个读音都只有一个音节，重音位置完全一样，
    按位置挑会给动词也挑成 /ɹɛd/。教错读音比不教更糟。
    """
    if len(variants) == 1:
        return variants[0], 1
    is_verb = pos.lower().strip(".") in VERB_POS
    return variants[1 if is_verb else 0], len(variants)


def main():
    import cmudict
    d = cmudict.dict()

    # 自检：CMUdict 用到的每个音素都必须有映射。
    # 漏一个的后果很隐蔽 —— UW 漏了，200 个词的音标会静悄悄少掉那个元音
    # （studio 变成「stdiˌoʊ」、blue 变成「bl」），肉眼看整体还挺像。
    used = set()
    for variants in d.values():
        for phones in variants:
            for ph in phones:
                used.add(split_phoneme(ph)[0])
    unmapped = sorted(used - set(ARPABET))
    if unmapped:
        sys.exit("ARPAbet->IPA 映射表漏了音素: %s\n"
                 "这些音素会被静默丢弃，音标会缺元音。" % ", ".join(unmapped))

    with io.open(B, encoding="utf-8") as fh:
        sel = json.load(fh)

    rows, miss, hetero, fb = [], [], [], []
    for w in sorted(sel.keys()):
        senses = sel[w]["senses"]
        lw = w.lower()
        src, via = lw, None
        if src not in d and lw in FALLBACK and FALLBACK[lw] in d:
            src, via = FALLBACK[lw], FALLBACK[lw]
        if src not in d:
            miss.append(w)
            continue
        # 一个词可能既有名词义又有动含义（N/V），逐义项选读音
        per_pos, prons = {}, []
        for s in senses:
            phones, _ = pick_by_pos(d[src], s.get("pos", ""))
            ipa = phones_to_ipa(phones)
            if not ipa:
                continue
            per_pos[s.get("pos", "")] = ipa
            if ipa not in prons:
                prons.append(ipa)
        if not prons:
            miss.append(w)
            continue
        if len(prons) > 1:
            hetero.append("%s(%s)" % (w, " ".join("/" + p + "/" for p in prons)))
        if via:
            fb.append("%s->%s" % (w, via))
        rows.append((w, " ".join("%s=%s" % kv for kv in sorted(per_pos.items())),
                     prons[0], len(d[src]), via or ""))

    with io.open(OUT, "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, delimiter="\t", lineterminator="\n")
        wr.writerow(["lemma", "byPos", "ipa", "nProns", "via"])
        wr.writerows(rows)

    print("写出 %s：%d 词" % (OUT, len(rows)))
    if hetero:
        print("  按词性分读音的词 %d 个：%s" % (len(hetero), ", ".join(hetero[:12])))
    if fb:
        print("  英式->美式映射命中 %d 个：%s" % (len(fb), ", ".join(fb)))
    if miss:
        print("  [缺] %d 个词没查到：%s" % (len(miss), ", ".join(miss[:20])))


if __name__ == "__main__":
    main()