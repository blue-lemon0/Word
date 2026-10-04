# -*- coding: utf-8 -*-
"""校验 docs/ 里的关键数字与实际数据是否一致。"""
import csv, io, json, os, re, sys, collections
sys.stdout.reconfigure(encoding="utf-8")
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(PROJ, "docs")
senses_dir = os.path.join(PROJ, "content-kit", "data", "wordlist", "senses")

# 词库口径直接从真相源 TSV 计算。双子系统拆分后不再读
# build/intermediate/ecdict_senses_{b,final}.json —— 那两个是已归档切分管线的
# 派生产物，无任何活脚本依赖，已作为死产物清理（见 d16 守卫）。
nw = ns = 0
tier = collections.Counter()
if os.path.isdir(senses_dir):
    for f in os.listdir(senses_dir):
        if not f.endswith(".tsv"):
            continue
        nw += 1
        with io.open(os.path.join(senses_dir, f), encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh, delimiter="\t"))
        ns += len(rows)
        if rows:
            tier[rows[0].get("tier", "")] += 1
keep = {"T1": 4, "T2": 3, "T3": 2, "T4": 1}

print("=== 实际数据（content-kit/data/wordlist/senses 真相源）===")
print("正式词库: %d 词 / %d 义项 / 平均 %.2f" % (nw, ns, ns / nw if nw else 0))
for t in ["T1", "T2", "T3", "T4"]:
    print("   %s %d词 x %d = %d" % (t, tier[t], keep[t], tier[t] * keep[t]))
print("5句/义项 = %d 句" % (ns * 5))
print("（全量切分 14237 义项是归档管线的历史口径，真相源只保留入选 7884）")

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
    ("14237 全量(仅历史口径)", "14237", True),
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
    # 注意：data/sentences/ 现为新语料的正式生成目标（不是 D16 删掉的旧垃圾）。
    # 这里要确认的是「旧句已归档」，而不是该目录不存在。
    ("旧句子已归档到 archive",
     os.path.exists(os.path.join(
         PROJ, "archive", "2026-09-30-pre-ECDICT", "manual-sentences", "MANUAL.tsv"))),
    ("旧 judge_results 已删除", not os.path.exists(os.path.join(PROJ, "build", "judge_results"))),
    ("senses_b 已并入 senses", not os.path.exists(os.path.join(PROJ, "assets", "senses_b"))),
    ("senses_ecdict 已删除", not os.path.exists(os.path.join(PROJ, "assets", "senses_ecdict"))),
    ("user_flags 已删除", not os.path.exists(os.path.join(PROJ, "assets", "user_flags.jsonl"))),
    ("旧流水线脚本已归档", os.path.isdir(os.path.join(PROJ, "archive",
                                                     "2026-09-30-pre-ECDICT", "scripts"))),
]

# 脚本分三类断言 —— 2026-10 双子系统拆分后：
#
#   活脚本（build_bundle，重建 bundle 的唯一入口，必须在 content-kit/pipeline/）
#   不可运行 ETL（输入是仓库外临时 CSV，或会就地改写不可再生快照；
#           保留只为溯源，在 archive/tools/etl-2026-09/）
#   已完成管线（source/ -> content-kit/data/wordlist/senses/ 已交付，重跑会覆写
#           入库数据，归档在 archive/2026-10-retire/scripts/）
PIPE_LIVE = ["build_bundle.py"]
PIPE_ARCHIVED_ETL = ["parse_ecdict.py", "fix_pos.py", "diag_senses.py",
                     "emit_senses.py"]
PIPE_ARCHIVED_DONE = ["build_senses.py", "select_tier_b.py", "emit_senses_b.py",
                      "build_ipa.py", "fix_gloss_2026-10.py"]
for f in PIPE_LIVE:
    d16.append(("活脚本 %s 在 content-kit/pipeline/" % f,
                os.path.exists(os.path.join(PROJ, "content-kit", "pipeline", f))))
for f in PIPE_ARCHIVED_ETL:
    d16.append(("不可运行 ETL %s 已归档" % f,
                os.path.exists(os.path.join(PROJ, "archive", "tools",
                                            "etl-2026-09", f))))
for f in PIPE_ARCHIVED_DONE:
    d16.append(("已完成管线 %s 不在 content-kit/pipeline/" % f,
                not os.path.exists(os.path.join(PROJ, "content-kit", "pipeline", f))))

# D17：最小循环的必备件。**前端只有一份** —— app/web/index.html，
# 服务端在 app/ 根。曾经另写过一套 app/index.html + app/app.js，
# 结果是原型被晾在一边、用户看到的是另一个界面。
APP = ["schema.sql", "srs.mjs", "db.mjs", "server.mjs"]
for f in APP:
    d16.append(("app/ 有 %s" % f, os.path.exists(os.path.join(PROJ, "app", f))))
d16 += [
    ("没有第二份前端 app/index.html",
     not os.path.exists(os.path.join(PROJ, "app", "index.html"))),
    ("没有第二份前端 app/app.js",
     not os.path.exists(os.path.join(PROJ, "app", "app.js"))),
    ("UI 唯一入口 app/web/index.html",
     os.path.exists(os.path.join(PROJ, "app", "web", "index.html"))),
]
# 原型的存档层必须接到服务端；CSS 与 markup 不能被改
_proto_path = os.path.join(PROJ, "app", "web", "index.html")
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
        ("原型引用的是 /build/bundle/cards.json",
         'BUNDLE_URL = "/build/bundle/cards.json"' in proto),
    ]
d16 += [
    ("SRS 参数文件存在", os.path.exists(os.path.join(
        PROJ, "app", "config", "srs_params.tsv"))),
    ("有 e2e_loop", os.path.exists(os.path.join(PROJ, "app", "tests", "e2e_loop.mjs"))),
    ("有 smoke_http", os.path.exists(os.path.join(PROJ, "app", "tests", "smoke_http.py"))),
    # 双子系统拆分后的入口文档与契约（2026-10）
    ("根 README 存在", os.path.exists(os.path.join(PROJ, "README.md"))),
    ("content-kit README 存在", os.path.exists(os.path.join(PROJ, "content-kit", "README.md"))),
    ("app README 存在", os.path.exists(os.path.join(PROJ, "app", "README.md"))),
    ("CONTRACT.md 存在", os.path.exists(os.path.join(PROJ, "CONTRACT.md"))),
    ("进度导入导出工具存在", os.path.exists(os.path.join(
        PROJ, "app", "tools", "progress_io.mjs"))),
    ("ECDICT 切分死产物已清理", all(not os.path.exists(
        os.path.join(PROJ, "build", "intermediate", f))
        for f in ("ecdict_senses_b.json", "ecdict_senses_final.json"))),
    # 选词范围表被活跃脚本读取（sentence_audit 的 CORE / pick_words），
    # 不是 archive 专属的参考件。
    # 曾在"清理冗余"时把它当成 archive 的重复件删掉，流水线直接 FileNotFoundError。
    ("选词范围表在位", os.path.exists(os.path.join(
        PROJ, "content-kit", "data", "wordlist", "kaoyan_dagang_core.tsv"))),
    # schema.sql 里的关键不变量不能被改掉
    ("schema 有 due_at 列", "due_at" in io.open(
        os.path.join(PROJ, "app", "schema.sql"), encoding="utf-8").read()),
    ("schema 有 attempt_id 幂等键", "attempt_id" in io.open(
        os.path.join(PROJ, "app", "schema.sql"), encoding="utf-8").read()),
]
# SRS 参数必须是代码之外的唯一真相源：verify_srs.py 不得再硬编码 S0/D0
_vsp = io.open(os.path.join(PROJ, "app", "tests", "verify_srs.py"), encoding="utf-8").read()
d16.append(("verify_srs.py 读参数文件不硬编码", "load_params" in _vsp))

# 脚本不得硬编码项目绝对路径：在克隆里跑流水线会把产物写回原目录。
# 扫描两个子系统的可执行脚本（根 scripts/ 只剩本守卫，无需扫自己）。
hardcoded = []
for scan in (os.path.join(PROJ, "content-kit", "pipeline"),
             os.path.join(PROJ, "app", "tests")):
    for f in sorted(os.listdir(scan)):
        if not (f.endswith(".py") or f.endswith(".mjs")):
            continue
        body = io.open(os.path.join(scan, f), encoding="utf-8").read()
        if re.search(r'["\'][A-Za-z]:\\\\projectX', body) or re.search(r'["\'][A-Za-z]:\\projectX', body):
            hardcoded.append(os.path.relpath(os.path.join(scan, f), PROJ))
d16.append(("脚本无硬编码项目路径", not hardcoded))
if hardcoded:
    print("       硬编码项目路径的脚本: %s" % ", ".join(hardcoded))
# 已废弃的脚本不得留在活管线目录
DEAD = ["map_senses.py", "stage1_senses.py", "stage2_sentences.py",
        "stage3_judge.py", "judge_audit.py", "llm_client.py"]
for f in DEAD:
    d16.append(("content-kit/pipeline/ 已无 %s" % f,
                not os.path.exists(os.path.join(PROJ, "content-kit", "pipeline", f))))
# 正式词库必须等于 B 方案
senses_dir = os.path.join(PROJ, "content-kit", "data", "wordlist", "senses")
n_tsv = len([f for f in os.listdir(senses_dir) if f.endswith(".tsv")]) if os.path.isdir(senses_dir) else -1
d16.append(("正式词库 = 2998 tsv", n_tsv == 2998))

# bundle 必须与新基线一致
bp = os.path.join(PROJ, "build", "bundle", "cards.json")
if os.path.exists(bp):
    b = json.load(io.open(bp, encoding="utf-8"))
    st = b["stats"]
    no_pos = [c for c in b["cards"] if not c.get("pos")]
    pl_pref = [c for c in b["cards"] if c.get("gloss", "").lower().startswith("pl. ")]
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
        ("bundle format 标识正确", b.get("format") == "word-bundle"),
        ("bundle schemaVersion = 1", b.get("schemaVersion") == 1),
        ("bundle cards = 7884", st["cards"] == 7884),
        # 句子按词递增生成，不钉死句数；只校验 stats 自洽
        ("bundle mode 与句数一致",
         st["mode"] == ("PARTIAL" if st["sentences"] > 0 else "SENSES_ONLY")),
        ("bundle 有句+无句 = 总义项",
         st["withSentences"] + st["noSentence"] == st["cards"]),
        ("bundle 句数 = 各卡句数之和",
         st["sentences"] == sum(len(c["sentences"]) for c in b["cards"])),
        ("全部卡有 sentences 数组", all(isinstance(c.get("sentences"), list) for c in b["cards"])),
        ("全部义项有词性", len(no_pos) == 0),
        ("无 pl. 前缀残留", len(pl_pref) == 0),
        # tier 必须真的落到 bundle 里：曾经写成 note=tier=T1 而 build_bundle 读 tier 列，
        # 导致 7884 张卡 tier 全空、UI 档位标签永不显示，且没有任何校验拦得住。
        ("正式词库 tier 列非空", all(tsv_tier.values()) and len(tsv_tier) == 2998),
        ("bundle tier 无空值", all(c.get("tier") for c in b["cards"])),
        ("bundle tier 与词库一致",
         all(c["tier"] == tsv_tier[c["word"]] for c in b["cards"])),
        ("每词义项数 <= keep[tier]",
         all(tsv_n[w] <= keep[tsv_tier[w]] for w in tsv_n)),
        # span 约定：精确指向**目标词**（界面要猜义项的那个词）。
        # 高亮句中别处的提示词等于没指示 —— 目标词已在顶部徽章上，
        # 句子里的第二次指示才告诉眼睛"看这个"。
        # 判定不猜词形：bundle 的 form 字段就是 span 处那段文本（laid/cast/…），
        # 由 sentence_audit.py --fix-spans 用 inflections() 机械算出。
        ("bundle span 全部指向目标词",
         all(r["form"] and r["form"] == r["text"][r["spanStart"]:r["spanStart"] + r["spanLen"]]
             for c in b["cards"] for r in c["sentences"])),
        ("bundle 每句都带目标词词形 form",
         all(r.get("form") for c in b["cards"] for r in c["sentences"])),
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
print("  14237-7884 = %d (文档 01 写 6353 丢失；14237 为归档管线历史口径) -> %s"
      % (14237 - ns, 14237 - ns == 6353))

print("\n总计: D16 检查 %d 项，失败 %d 项" % (len(d16), f16))
sys.exit(1 if (f16 or stale) else 0)
