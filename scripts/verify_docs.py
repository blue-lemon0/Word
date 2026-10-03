# -*- coding: utf-8 -*-
"""校验 docs/ 里的关键数字与实际数据是否一致。"""
import csv, io, json, os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(PROJ, "docs")

sel_path = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_b.json")
fin_path = os.path.join(PROJ, "assets", "wordlists", "ecdict_senses_final.json")
if not (os.path.exists(sel_path) and os.path.exists(fin_path)):
    # 这两个是切分中间产物，已被 .gitignore 排除（D17）。新克隆的仓库要重跑一遍。
    sys.stderr.write(
        "缺少 ECDICT 切分中间产物（不在版本库里，属派生产物）。请先跑：\n"
        "  python scripts/build_senses.py     # raw -> final\n"
        "  python scripts/select_tier_b.py    # final -> b\n")
    sys.exit(2)
sel = json.load(io.open(sel_path, encoding="utf-8"))
fin = json.load(io.open(fin_path, encoding="utf-8"))
ns = sum(len(v["senses"]) for v in sel.values())
nfull = sum(len(v["senses"]) for v in fin.values())
nw = len(sel)
tier = collections.Counter(v["tier"] for v in sel.values())
keep = {"T1": 4, "T2": 3, "T3": 2, "T4": 1}

print("=== 实际数据 ===")
print("B 方案: %d 词 / %d 义项 / 平均 %.2f" % (nw, ns, ns / nw))
print("全量:   %d 义项 (平均 %.2f)" % (nfull, nfull / len(fin)))
for t in ["T1", "T2", "T3", "T4"]:
    print("   %s %d词 x %d = %d" % (t, tier[t], keep[t], tier[t] * keep[t]))
multi = sum(1 for v in sel.values() if len(v["senses"]) >= 2)
print("多义词 %.1f%%  单义 %d" % (multi / nw * 100,
                                sum(1 for v in sel.values() if len(v["senses"]) == 1)))
print("5句/义项 = %d 句" % (ns * 5))

print("\n=== 文档一致性 ===")
docs = {}
for r, ds, fs in os.walk(DOCS):
    for f in fs:
        if f.endswith(".md"):
            p = os.path.join(r, f)
            docs[os.path.relpath(p, DOCS)] = io.open(p, encoding="utf-8").read()
for k, t in sorted(docs.items()):
    print("  %-42s %5d 字符" % (k, len(t)))

blob = "\n".join(docs.values())
checks = [
    ("7884 义项数", "7884", ns == 7884),
    ("2998 词数", "2998", nw == 2998),
    ("2.63 平均", "2.63", abs(ns / nw - 2.63) < 0.005),
    ("T1 663", "663", tier["T1"] == 663),
    ("T2 1218", "1218", tier["T2"] == 1218),
    ("T3 1011", "1011", tier["T3"] == 1011),
    ("T4 106", "106", tier["T4"] == 106),
    ("14237 全量", "14237", nfull == 14237),
    ("39420 句需求", "39420", ns * 5 == 39420),
    ("13260 T1 首批", "13260", tier["T1"] * 4 * 5 == 13260),
    # D16 之后：这些数字只允许出现在 D15/D16 的历史记录里
    ("13703 emit数", "13703", "13703" in blob),
    ("68.0% 复用(仅历史)", "68.0", "68.0" in blob),
    ("405 人工句(已归档)", "405", "405" in blob),
    ("642 TRAP(已归档)", "642", "642" in blob),
]
for name, needle, ok in checks:
    inany = needle in blob
    flag = "OK " if (ok and inany) else ("数据不符" if not ok else "文档缺")
    print("  [%s] %-20s 期望含'%s'  实际数据符合=%s  文档中有=%s"
          % (flag, name, needle, ok, inany))

# D16：旧数据不得再被描述成"待迁移"或"可复用"
print("\n=== D16 断舍离一致性 ===")
d16 = [
    ("有 D16 决策文档", os.path.exists(os.path.join(DOCS, "decisions", "D16-断舍离.md"))),
    ("有 archive 目录", os.path.isdir(os.path.join(PROJ, "archive", "2026-09-30-pre-ECDICT"))),
    ("archive 有 ARCHIVE.md", os.path.exists(os.path.join(
        PROJ, "archive", "2026-09-30-pre-ECDICT", "ARCHIVE.md"))),
    ("人工句已归档 405", os.path.exists(os.path.join(
        PROJ, "archive", "2026-09-30-pre-ECDICT", "manual-sentences", "MANUAL.tsv"))),
    ("TRAP 快照已归档", os.path.exists(os.path.join(
        PROJ, "archive", "2026-09-30-pre-ECDICT", "old-senses", "TRAP_AND_GLOSSEN.tsv"))),
    # 注意：assets/sentences/ 现为新语料的正式生成目标（不是 D16 删掉的旧垃圾）。
    # 这里要确认的是「旧句已归档」，而不是该目录不存在。
    ("旧句子已归档到 archive",
     os.path.exists(os.path.join(
         PROJ, "archive", "2026-09-30-pre-ECDICT", "manual-sentences", "MANUAL.tsv"))),
    ("旧 judge_results 已删除", not os.path.exists(os.path.join(PROJ, "assets", "judge_results"))),
    ("senses_b 已并入 senses", not os.path.exists(os.path.join(PROJ, "assets", "senses_b"))),
    ("senses_ecdict 已删除", not os.path.exists(os.path.join(PROJ, "assets", "senses_ecdict"))),
    ("user_flags 已删除", not os.path.exists(os.path.join(PROJ, "assets", "user_flags.jsonl"))),
    ("旧流水线脚本已归档", os.path.isdir(os.path.join(PROJ, "archive",
                                                     "2026-09-30-pre-ECDICT", "scripts"))),
]

# 正式流水线必须齐备
PIPE = ["parse_ecdict.py", "fix_pos.py", "diag_senses.py", "build_senses.py",
        "select_tier_b.py", "emit_senses_b.py", "build_bundle.py"]
for f in PIPE:
    d16.append(("流水线有 %s" % f, os.path.exists(os.path.join(PROJ, "scripts", f))))

# D17：最小循环的必备件。**前端只有一份** —— tools/index.html（原型），
# app/ 只放服务端。曾经另写了一套 app/index.html + app/app.js，
# 结果是原型被晾在一边、用户看到的是另一个界面。
APP = ["schema.sql", "srs.mjs", "db.mjs", "server.mjs"]
for f in APP:
    d16.append(("app/ 有 %s" % f, os.path.exists(os.path.join(PROJ, "app", f))))
d16 += [
    ("没有第二份前端 app/index.html",
     not os.path.exists(os.path.join(PROJ, "app", "index.html"))),
    ("没有第二份前端 app/app.js",
     not os.path.exists(os.path.join(PROJ, "app", "app.js"))),
    ("原型在 tools/index.html",
     os.path.exists(os.path.join(PROJ, "tools", "index.html"))),
]
# 原型的存档层必须接到服务端；CSS 与 markup 不能被改
_proto_path = os.path.join(PROJ, "tools", "index.html")
if os.path.exists(_proto_path):
    proto = io.open(_proto_path, encoding="utf-8").read()
    proto_base = os.path.join(PROJ, "archive", "2026-09-30-pre-ECDICT")
    d16 += [
        ("原型判别区高亮仍是实心药丸",
         ".sentence mark {" in proto and "background: var(--primary);" in proto),
        ("原型三件套还在（错题板/手动掌握/双 tab）",
         all(k in proto for k in
             ["markMastered", 'id="viewBoard"', "function switchTab", "错题板"])),
        ("原型已接服务端存档",
         all(k in proto for k in
             ["/api/ui-state", "/api/answer", "/api/mastered", "pushState"])),
        ("原型引用的是 /assets/bundle/cards.json",
         'BUNDLE_URL = "/assets/bundle/cards.json"' in proto),
    ]
d16 += [
    ("SRS 参数文件存在", os.path.exists(os.path.join(
        PROJ, "assets", "profile", "srs_params.tsv"))),
    ("有 e2e_loop", os.path.exists(os.path.join(PROJ, "scripts", "e2e_loop.mjs"))),
    ("有 smoke_http", os.path.exists(os.path.join(PROJ, "scripts", "smoke_http.py"))),
    # 选词范围表被正式流水线读取（parse_ecdict / build_senses / select_tier_b /
    # diag_senses / emit_senses），不是 archive 专属的参考件。
    # 曾在"清理冗余"时把它当成 archive 的重复件删掉，流水线直接 FileNotFoundError。
    ("选词范围表在位", os.path.exists(os.path.join(
        PROJ, "assets", "wordlists", "kaoyan_dagang_core.tsv"))),
    # schema.sql 里的关键不变量不能被改掉
    ("schema 有 due_at 列", "due_at" in io.open(
        os.path.join(PROJ, "app", "schema.sql"), encoding="utf-8").read()),
    ("schema 有 attempt_id 幂等键", "attempt_id" in io.open(
        os.path.join(PROJ, "app", "schema.sql"), encoding="utf-8").read()),
]
# SRS 参数必须是代码之外的唯一真相源：verify_srs.py 不得再硬编码 S0/D0
_vsp = io.open(os.path.join(PROJ, "scripts", "verify_srs.py"), encoding="utf-8").read()
d16.append(("verify_srs.py 读参数文件不硬编码", "load_params" in _vsp))

# 脚本不得硬编码项目绝对路径：在克隆里跑流水线会把产物写回原目录
hardcoded = []
for f in sorted(os.listdir(os.path.join(PROJ, "scripts"))):
    if not (f.endswith(".py") or f.endswith(".mjs")):
        continue
    body = io.open(os.path.join(PROJ, "scripts", f), encoding="utf-8").read()
    if re.search(r'["\'][A-Za-z]:\\\\projectX', body) or re.search(r'["\'][A-Za-z]:\\projectX', body):
        hardcoded.append(f)
d16.append(("脚本无硬编码项目路径", not hardcoded))
if hardcoded:
    print("       硬编码项目路径的脚本: %s" % ", ".join(hardcoded))
# 已废弃的脚本不得留在 scripts/
DEAD = ["map_senses.py", "stage1_senses.py", "stage2_sentences.py",
        "stage3_judge.py", "judge_audit.py", "llm_client.py"]
for f in DEAD:
    d16.append(("scripts/ 已无 %s" % f,
                not os.path.exists(os.path.join(PROJ, "scripts", f))))
# 正式词库必须等于 B 方案
senses_dir = os.path.join(PROJ, "assets", "senses")
n_tsv = len([f for f in os.listdir(senses_dir) if f.endswith(".tsv")]) if os.path.isdir(senses_dir) else -1
d16.append(("正式词库 = 2998 tsv", n_tsv == 2998))

# bundle 必须与新基线一致
bp = os.path.join(PROJ, "assets", "bundle", "cards.json")
if os.path.exists(bp):
    b = json.load(io.open(bp, encoding="utf-8"))
    st = b["stats"]
    no_pos = [c for c in b["cards"] if not c.get("pos")]
    pl_pref = [c for c in b["cards"] if c.get("zh", "").lower().startswith("pl. ")]
    # 正式词库里每词的义项数，用于校验 tier 的 keep 上限
    tsv_n = collections.Counter()
    tsv_tier = {}
    for f in os.listdir(senses_dir):
        if not f.endswith(".tsv"):
            continue
        rows = list(csv.DictReader(io.open(os.path.join(senses_dir, f),
                                           encoding="utf-8"), delimiter="\t"))
        tsv_n[f[:-4]] = len(rows)
        if rows:
            tsv_tier[f[:-4]] = rows[0].get("tier", "")
    d16 += [
        ("bundle cards = 7884", st["cards"] == 7884),
        # 句子按词递增生成，不钉死句数；只校验 stats 自洽
        ("bundle mode 与句数一致",
         st["mode"] == ("PARTIAL" if st["sentences"] > 0 else "SENSES_ONLY")),
        ("bundle 有句+无句 = 总义项",
         st["withSentences"] + st["noSentence"] == st["cards"]),
        ("bundle 句数 = 各卡句数之和",
         st["sentences"] == sum(len(c["rows"]) for c in b["cards"])),
        ("全部卡有 rows 数组", all(isinstance(c.get("rows"), list) for c in b["cards"])),
        ("全部义项有词性", len(no_pos) == 0),
        ("无 pl. 前缀残留", len(pl_pref) == 0),
        # tier 必须真的落到 bundle 里：曾经写成 note=tier=T1 而 build_bundle 读 tier 列，
        # 导致 7884 张卡 tier 全空、UI 档位标签永不显示，且没有任何校验拦得住。
        ("正式词库 tier 列非空", all(tsv_tier.values()) and len(tsv_tier) == 2998),
        ("bundle tier 无空值", all(c.get("tier") for c in b["cards"])),
        ("bundle tier 与词库一致",
         all(c["tier"] == tsv_tier[c["w"]] for c in b["cards"])),
        ("每词义项数 <= keep[tier]",
         all(tsv_n[w] <= keep[tsv_tier[w]] for w in tsv_n)),
        # span 约定：精确指向 clue（UI 用 <mark> 高亮作提示）
        ("bundle span 全部指向 clue",
         all(r["t"][r["ss"]:r["ss"] + r["sl"]] == r["c"]
             for c in b["cards"] for r in c["rows"])),
    ]
else:
    d16.append(("bundle 存在", False))

f16 = 0
for name, ok in d16:
    print("  [%s] %s" % ("OK " if ok else "FAIL", name))
    if not ok:
        f16 += 1

# 迁移类措辞残留
print("\n=== 迁移措辞残留检查（应为 0 处待办）===")
stale = []
for k, t in sorted(docs.items()):
    for pat in ["待迁移", "句子重映射", "可复用 68", "映射成功 ──> 保留"]:
        if pat in t:
            stale.append("%s: %s" % (k, pat))
if stale:
    for s in stale:
        print("  [FAIL]", s)
else:
    print("  [OK ] 无残留待迁移措辞")

# 检查文档里是否残留"7884 义项"但 30 句上限算错
print("\n=== 算术抽查 ===")
print("  7884 x 30 = %d (文档 05 写 236520) -> %s" % (ns * 30, ns * 30 == 236520))
print("  7884 x 5  = %d (文档 01 写 39420)  -> %s" % (ns * 5, ns * 5 == 39420))
print("  663 x 4   = %d (T1 义项)          -> %s" % (tier["T1"] * 4, tier["T1"] * 4 == 2652))
print("  2652 x 5  = %d (文档01 写 13260)    -> %s" % (tier["T1"] * 4 * 5, tier["T1"] * 4 * 5 == 13260))
print("  14237-7884 = %d (文档 01 写 6353 丢失) -> %s"
      % (nfull - ns, nfull - ns == 6353))

print("\n总计: D16 检查 %d 项，失败 %d 项" % (len(d16), f16))
sys.exit(1 if (f16 or stale) else 0)
