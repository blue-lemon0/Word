# -*- coding: utf-8 -*-
"""修 GLOSS 规则查出的真实内容错误。

sentence_audit 的 GLOSS 规则查出 53 条 note 释义与词库对不上，其中 36 句在教错的
义项。这三类要动内容，另 17 条只是措辞差异。

## 三词的性质各不相同，处理方式也不同

**terrible** —— 英语句子本身没错，是**内容整体错位**：
  s1（可怕的）装的却是「极坏的」素材（the night/food/handwriting/weather/service）
  s2（令人恐惧的）装的也是「极坏的」素材（外表/路况差）
  s3（极坏的）装的却是「令人恐惧的」素材（noise/cry/smell/howl/crash）
  s1「可怕的」根本没有内容。
  → s3 接回原来 s1 的 5 句（它们正是「极坏的」），s1/s2 写 10 句新的。

**civil** —— s2 装的是 s3 的内容，s3 装的是**根本不在字典里的义项**（内战）：
  s1（市民的）装的是「公民的/公务员的/民用的」混合
  s2（公民的）装的是「有礼貌的」
  s3（有礼貌的）装的是内战 x5
  → s3 接回原来 s2 的 5 句（正是有礼貌的），s1/s2 重写。

**injury** —— s2（侮辱）句子方向对（伤害自尊/名誉），错的是 label 标成了 s1 的「伤害」。
  → 句子微调让侮辱框更明确，note 用字典原文「侮辱」。

## 顺序很重要

先改内容，再统一 note。反过来的话，机械替换 note 会把 terrible/civil/injury 的
真实错误**掩盖成通过** —— 这正是我不先跑机械替换的原因。
"""
import csv
import io
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
PROJ = r"D:\projectX\android\Word"
sys.path.insert(0, os.path.join(PROJ, "scripts"))
import sentence_audit as sa  # noqa: E402

SDIR = os.path.join(PROJ, "data", "sentences")

# 每行 = (senseId, 英文, clue, 译文, 说明)
REWRITE = {
    "terrible": {
        "s1": [  # 可怕的 —— 原先没有任何内容，这个义项是空的
            ("A terrible storm hit the small island that night.",
             "A terrible storm", "那晚一场可怕的风暴袭击了这座小岛。",
             "让人害怕的灾祸 = 可怕的"),
            ("The farmers still talk about that terrible flood.",
             "that terrible flood", "农民们至今还在讲那场可怕的水灾。",
             "灾害记忆 = 可怕的"),
            ("A terrible cry came from the empty house.",
             "A terrible cry", "空屋里传出一声可怕的喊叫。",
             "可怖的声音 = 可怕的"),
            ("He told us the terrible news about his brother.",
             "the terrible news", "他告诉了我们关于他哥哥的可怕消息。",
             "骇人的消息 = 可怕的"),
            ("The dog gave a terrible howl just before dawn.",
             "a terrible howl", "黎明前那条狗发出了一声可怕的嗥叫。",
             "骇人的叫声 = 可怕的"),
        ],
        "s2": [  # 令人恐惧的 —— 侧重「令人产生恐惧」，与 s1 侧重「那东西很可怕」不同
            ("The speed of that fall was terrible to watch.",
             "terrible to watch", "那个坠落的速度看着令人恐惧。",
             "观感引发恐惧 = 令人恐惧的"),
            ("She said the noise from that night was terrible.",
             "was terrible", "她说那晚的噪音令人恐惧。",
             "声音引发恐惧 = 令人恐惧的"),
            ("The doctor warned that the pain would be terrible.",
             "would be terrible", "医生警告说疼痛会令人恐惧。",
             "预期的痛苦 = 令人恐惧的"),
            ("What they saw at the top of that road was terrible.",
             "was terrible", "他们在那条路顶端看到的东西令人恐惧。",
             "所见引发恐惧 = 令人恐惧的"),
            ("He said the storm along that coast was truly terrible.",
             "was truly terrible", "他说那条海岸上的风暴真令人恐惧。",
             "亲历的恐惧 = 令人恐惧的"),
        ],
        "s3": [  # 极坏的 —— 接回原来 s1 的 5 句，它们正是这个意思
            ("The night was terrible and nobody slept.",
             "and nobody slept", "那夜糟透了，谁都没睡着。",
             "整夜难眠 = 极坏的"),
            ("The food in that shop was simply terrible.",
             "simply terrible", "那家店的食物简直糟透了。",
             "难吃 = 极坏的"),
            ("His handwriting is terrible; nobody can read it.",
             "nobody can read it", "他的字糟糕透了，谁都认不出来。",
             "字迹难认 = 极坏的"),
            ("The weather was terrible, so we stayed at home.",
             "so we stayed at home", "天气糟透了，我们就待在家里。",
             "天气恶劣 = 极坏的"),
            ("The service in that hotel was terrible.",
             "was terrible", "那家酒店的服务糟透了。",
             "服务质量差 = 极坏的"),
        ],
    },
    "civil": {
        "s1": [  # 市民的 —— 侧重「城市居民/市民身份」
            ("Every civil duty in that town is listed on the wall.",
             "Every civil duty", "那个镇上的每项市民义务都列在墙上。",
             "市民义务 = 市民的"),
            ("The city council held a civil vote last spring.",
             "a civil vote", "市议会去年春天举行了市民表决。",
             "市民表决 = 市民的"),
            ("He serves on the civil board of the school.",
             "the civil board", "他是校董事会的成员。",
             "校董会 = 市民的（公共机构）"),
            ("That is a civil matter, not a criminal one.",
             "a civil matter", "那是民事事务，不是刑事的。",
             "民事的 = 市民的"),
            ("The civil side of the court sits next to the criminal court.",
             "The civil side", "民事庭设在刑事法庭旁边。",
             "民事法庭 = 市民的"),
        ],
        "s2": [  # 公民的 —— 侧重「公民身份/权利义务」
            ("Civil rights are the first thing a new group must protect.",
             "Civil rights", "公民权利是任何新群体首先要保护的东西。",
             "公民权利 = 公民的"),
            ("The war ended and civil rights returned to normal.",
             "civil rights", "战争结束，公民权利恢复正常。",
             "战时的公民权利 = 公民的"),
            ("Every citizen has civil duties as well as civil rights.",
             "civil duties", "每个公民既有公民权利也有公民义务。",
             "公民义务 = 公民的"),
            ("They fought for civil freedom for twenty years.",
             "civil freedom", "他们为公民自由斗争了二十年。",
             "公民自由 = 公民的"),
            ("The law protects civil rights in every public place.",
             "civil rights", "法律在每个公共场所保护公民权利。",
             "法律保障 = 公民的"),
        ],
        "s3": [  # 有礼貌的 —— 接回原来 s2 的 5 句，它们正是这个意思
            ("He was a civil man with a quiet voice.",
             "a civil man", "他是个说话轻声细语的礼貌人。",
             "有礼貌的人 = 有礼貌的"),
            ("It was civil of you to wait for me.",
             "It was civil of you", "你等我，真是太有礼貌了。",
             "It was civil of sb = 有礼貌的"),
            ("She answered the rude boy in a civil way.",
             "in a civil way", "她以礼貌的方式回答了那个粗鲁的男孩。",
             "in a civil way = 有礼貌的"),
            ("His civil voice made the teacher calm again.",
             "His civil voice", "他礼貌的语气让老师平静下来。",
             "礼貌的语气 = 有礼貌的"),
            ("He was civil to everyone, even his enemy.",
             "civil to everyone", "他对每个人都很礼貌，连敌人也是。",
             "be civil to = 有礼貌的"),
        ],
    },
    "injury": {
        "s2": [  # 侮辱 —— 原句方向对（伤害自尊），但要更明确是「侮辱」
            ("His last words were an injury she never forgot.",
             "an injury", "他最后的话是句让她永不忘怀的侮辱。",
             "中伤的话 = 侮辱"),
            ("The long list was a public injury to his whole family.",
             "a public injury", "那份名单是对他全家的公开侮辱。",
             "当众羞辱 = 侮辱"),
            ("That cruel review was a clear injury to the writer.",
             "a clear injury", "那篇刻薄的评论是对那位作者的公然侮辱。",
             "恶意评论 = 侮辱"),
            ("His silence for weeks was a quiet injury to her.",
             "a quiet injury", "他沉默数周是对她的一种无声侮辱。",
             "冷处理 = 侮辱"),
            ("Every public correction felt like an injury to him.",
             "an injury to him", "每一次当众纠正都让他感到被侮辱。",
             "当众使人难堪 = 侮辱"),
        ],
    },
}


def main():
    problems = []

    # ── 第一步：改内容 ───────────────────────────────────
    for word, groups in REWRITE.items():
        src = os.path.join(SDIR, word + ".tsv")
        with io.open(src, encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter="\t"))
        fields = list(rows[0].keys())

        by = {}
        for r in rows:
            by.setdefault(r["senseId"], []).append(r)

        for sid, new in groups.items():
            if sid not in by:
                problems.append("%s#%s 不存在" % (word, sid))
                continue
            if len(by[sid]) != 5:
                problems.append("%s#%s 原 %d 句，不是 5" % (word, sid, len(by[sid])))
            if len(new) != 5:
                problems.append("%s#%s 新写 %d 句，不是 5" % (word, sid, len(new)))
            # 保留原有 span_start/span_len 的位置（下面统一用 --fix-spans 重算）
            for i, (text, clue, tr, note) in enumerate(new):
                slot = by[sid][i]
                slot["text"] = text
                slot["clue"] = clue
                slot["translation"] = tr
                slot["note"] = note

        with io.open(src, "w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=fields, delimiter="\t",
                               lineterminator="\n", quoting=csv.QUOTE_NONE)
            w.writeheader()
            for r in rows:
                w.writerow(r)
        print("改写 %-9s %d 个义项" % (word, len(groups)))

    # ── 第二步：note 的释义一律用词库 glossZh 原文 ────────
    #
    # 剩下 17 条是措辞差异（解散/散会 vs 解散、酒红 vs 暗红色），不是内容错误。
    # 统一成字典原文后：note 的释义字段成为「该义项在词库里的正式释义」，
    # 不再是每个批次各写各的近义词 —— GLOSS 规则才真正有意义。
    # 内容改完再做这步，否则会把 terrible/civil/injury 的真错掩盖成通过。
    fixed = 0
    for fn in sorted(os.listdir(SDIR)):
        if not fn.endswith(".tsv"):
            continue
        w = fn[:-4]
        gloss = {x["senseId"]: x["glossZh"] for x in sa.load_senses(w)}
        src = os.path.join(SDIR, fn)
        with io.open(src, encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter="\t"))
        fields = list(rows[0].keys())
        dirty = False
        for r in rows:
            real = (gloss.get(r["senseId"]) or "").strip()
            if not real or " = " not in r["note"]:
                continue
            head = r["note"].rsplit(" = ", 1)[0]
            want = "%s = %s" % (head, real)
            if r["note"] != want:
                r["note"] = want
                dirty = True
                fixed += 1
        if dirty:
            with io.open(src, "w", encoding="utf-8", newline="") as fh:
                wr = csv.DictWriter(fh, fieldnames=fields, delimiter="\t",
                                    lineterminator="\n", quoting=csv.QUOTE_NONE)
                wr.writeheader()
                for r in rows:
                    wr.writerow(r)
    print("note 释义对齐词库原文：%d 条" % fixed)

    if problems:
        print("\n有问题，未完成：")
        for p in problems:
            print("  " + p)
        sys.exit(1)

    # ── 第三步：落盘后自检 ────────────────────────────────
    r = sa.audit(verbose=False)
    print("\n落盘后质检：PASS %d / REJECT %d" % (r["ok"], r["bad"]))
    for w, vv in sorted(r["per_word"].items()):
        for v in vv:
            for code, msg in v["fails"]:
                print("  [%s#%s] %-6s %s" % (w, v["senseId"], code, msg))


if __name__ == "__main__":
    main()