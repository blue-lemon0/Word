# -*- coding: utf-8 -*-
"""构建原型/Stage4 用的紧凑聚合包（content-kit 的导出物，app 的导入物）。

契约格式详见仓库根 CONTRACT.md。字段全部自解释（不用缩写）：

产物 build/bundle/cards.json：
{
  "format": "word-bundle", "schemaVersion": 1,
  "version": "...",
  "stats": {"words":2998,"senses":7884,"withSentences":0,"cards":7884,"glossPool":N},
  "glossPool": ["释义1","释义2",...],          # 跨词干扰项池
  "cards": [
    {"id":"lay#s1","word":"lay","senseId":"s1","pos":"vt.","gloss":"放置",
     "glossEn":"","trap":0,"tier":"T1","ipa":"...",
     "sentences": [{
        # form = 目标词在句中的实际词形（laid / cast / running…），
        #   spanStart/spanLen 指向的就是它。下游不必再猜词形规则。
        "text":"...","form":"laid","clue":"clue",
        "spanStart":4,"spanLen":4,
        "translation":"...","note":"...","source":"GENERATED"}]}
  ]
}

D16 之后的要点：
  1. 义项表是唯一真相源，**没有句子的义项也要成卡**（sentences 为空）。
     旧版会把无 PASS 句的义项丢掉，导致词库里"消失"一部分义项——
     那是内容缺失，不该由打包逻辑掩盖。
  2. 句子目录不存在时（LLM 通道禁用期）自动降级为纯义项包。
  3. 干扰项池从全部义项的 glossZh 构建，不依赖句子。
"""
import csv, hashlib, io, json, os, sys, time, collections

# KIT = content-kit/（本脚本上两级）；REPO = 仓库根。
# data/source/spec 归 content-kit；build/ 是根级交接区（app 从这里导入）。
KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(KIT)
S = os.path.join(KIT, "data", "sentences")
SE = os.path.join(KIT, "data", "wordlist", "senses")
J = os.path.join(REPO, "build", "judge_results")
OUT = os.path.join(REPO, "build", "bundle", "cards.json")

has_sent = os.path.isdir(S)
has_judge = os.path.isdir(J)

# 1) PASS 句集合（judge 目录不存在时为空集 = 收全部句）
pass_set = collections.defaultdict(set)
if has_judge:
    for f in os.listdir(J):
        if not f.endswith(".tsv"):
            continue
        lemma = f[:-4]
        with open(os.path.join(J, f), encoding="utf-8") as fh:
            for r in csv.DictReader(fh, delimiter="\t"):
                if r.get("passed") == "PASS":
                    pass_set[lemma].add((r["senseId"], r["text"]))

def load_ipa():
    """word\tbyPos\tipa\t... —— byPos 形如 "n=ɹɛd v=ɹid"（CMUdict 转 IPA）。

    音标是**词性相关**的：read 名词 /ɹɛd/、动词 /ɹid/，所以按卡片自己的
    pos 取，取不到就退回该词的主读音。查不到音标的词返回空串，界面上不显示。
    """
    path = os.path.join(KIT, "data", "wordlist", "ipa.tsv")
    if not os.path.exists(path):
        sys.stderr.write(
            "缺少 content-kit/data/wordlist/ipa.tsv —— 该文件平时已入库，真缺失说明数据损坏；\n"
            "重生成需把 archive/2026-10-retire/scripts/build_ipa.py 取出（需 cmudict）\n")
        return {}
    out = {}
    with io.open(path, encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            by_pos = {}
            for kv in (r.get("byPos") or "").split():
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    by_pos[k.strip(".")] = v
            out[r["lemma"]] = {"byPos": by_pos, "ipa": r.get("ipa", "")}
    return out


def ipa_of(tbl, lemma, pos):
    e = tbl.get(lemma)
    if not e:
        return ""
    return e["byPos"].get((pos or "").strip(".").lower()) or e["ipa"] or ""


cards = []
ipa_tbl = load_ipa()
gloss_pool = []
gloss_seen = set()
n_sent = 0
n_no_sent = 0
n_words = 0

for f in sorted(os.listdir(SE)):
    if not f.endswith(".tsv"):
        continue
    lemma = f[:-4]
    with open(os.path.join(SE, f), encoding="utf-8") as fh:
        senses = list(csv.DictReader(fh, delimiter="\t"))
    n_words += 1

    rows_by = collections.defaultdict(list)
    spath = os.path.join(S, f"{lemma}.tsv")
    if os.path.exists(spath):
        with open(spath, encoding="utf-8") as fh:
            for r in csv.DictReader(fh, delimiter="\t"):
                if not has_judge or (r["senseId"], r["text"]) in pass_set.get(lemma, ()):
                    rows_by[r["senseId"]].append(r)

    for s in senses:
        sid = s["senseId"]
        rs = rows_by.get(sid, [])
        zh = s.get("glossZh", "")
        if zh and zh not in gloss_seen:
            gloss_seen.add(zh)
            gloss_pool.append(zh)
        if not rs:
            n_no_sent += 1
        n_sent += len(rs)
        cards.append({
            "id": f"{lemma}#{sid}",
            "word": lemma, "senseId": sid,
            "pos": s.get("pos", ""),
            "ipa": ipa_of(ipa_tbl, lemma, s.get("pos", "")),
            "gloss": zh,
            "glossEn": s.get("glossEn", ""),
            "trap": 1 if s.get("trap") == "1" else 0,
            "tier": s.get("tier", ""),
            "sentences": [{
                "text": r["text"],
                # form = span 处那段文本，即目标词的实际词形。
                # 不规则动词（lay->laid）猜不出来，直接把结果带进 bundle。
                "form": r["text"][int(r.get("span_start") or 0):
                               int(r.get("span_start") or 0) + int(r.get("span_len") or 0)],
                "clue": r.get("clue", ""),
                "spanStart": int(r.get("span_start") or 0),
                "spanLen": int(r.get("span_len") or 0),
                "translation": r.get("translation", ""),
                "note": r.get("note", ""),
                "source": r.get("source", ""),
            } for r in rs],
        })

# 句子是逐词增量加的，一天里常常改好几次；日期版 version 会让 app/db.mjs 的
# syncBundle 判定「bundle 没变」而跳过重建 —— 于是新句子永远进不了 App，
# 而界面上看不出任何异常。症状：刚生成的句子在浏览器里不出现。
h = hashlib.sha1()
for c in cards:
    h.update(("%s\x1f%s\x1f%d\x1f%s\x1f%d\x1e" % (
        c["word"], c["senseId"], len(c["sentences"]), c["gloss"], c["trap"])).encode("utf-8"))
    for r in c["sentences"]:
        h.update(("%s\x1f%s\x1e" % (r["text"], r["clue"])).encode("utf-8"))
version = "%s-%s" % (time.strftime("%Y%m%d"), h.hexdigest()[:8])

bundle = {
    "format": "word-bundle",
    "schemaVersion": 1,
    "version": version,
    "stats": {
        "words": n_words,
        "senses": len(cards),
        "cards": len(cards),
        "withSentences": len(cards) - n_no_sent,
        "sentences": n_sent,
        "glossPool": len(gloss_pool),
        "traps": sum(1 for c in cards if c["trap"]),
        "noSentence": n_no_sent,
        "mode": "FULL" if n_no_sent == 0 else "SENSES_ONLY" if n_sent == 0 else "PARTIAL",
    },
    "glossPool": gloss_pool,
    "cards": cards,
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(bundle, fh, ensure_ascii=False, separators=(",", ":"))

size = os.path.getsize(OUT)
st = bundle["stats"]
print("构建完成  mode=%s  version=%s" % (st["mode"], version))
print("  words           :", st["words"])
print("  cards(义项级)   :", st["cards"])
print("  sentences       :", st["sentences"])
print("  有句义项        :", st["withSentences"])
print("  无句义项        :", st["noSentence"])
print("  trap            :", st["traps"])
print("  glossPool       :", st["glossPool"])
print("  文件大小        : {:.3f} MB".format(size / 1024 / 1024))
print("  ->", OUT)
if st["noSentence"]:
    print("\n  [注意] %d 个义项没有例句，原型需能显示「暂无例句」状态" % st["noSentence"])

d = collections.Counter(len(c["sentences"]) for c in cards)
print("  每卡句数分布:", dict(sorted(d.items())))
