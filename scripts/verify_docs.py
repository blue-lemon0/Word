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
# 前端的四条设计判断必须还在（目标词高亮 / 错题板 / 手动掌握 / 句子标记）。
# 2026-10 前端从单文件原型重写成 Vue 应用（app/web/src/），判据本身没变
# （docs/DESIGN-词库系统v2.md §10.2），守卫跟着换成对 src/ 的检查。
WEB_SRC = os.path.join(PROJ, "app", "web", "src")


def _src(rel):
    p = os.path.join(WEB_SRC, rel)
    return io.open(p, encoding="utf-8").read() if os.path.exists(p) else ""


def _vant_icon_exists(name):
    """图标名是否在 Vant 内置图标表里。
    表真身在 vant/lib/index.css 的 .van-icon-xxx:before 规则里 —— 那是唯一的
    真相源，比维护一份自己的清单可靠（Vant 升级也不会漏）。"""
    css = os.path.join(PROJ, "app", "web", "node_modules", "vant", "lib", "index.css")
    if not os.path.exists(css):
        return True  # 没装依赖时不误报
    return (".van-icon-%s:before" % name) in io.open(css, encoding="utf-8").read()


_train = _src(os.path.join("pages", "TrainPage.vue"))
_board = _src(os.path.join("pages", "BoardPage.vue"))
_style = _src("style.css")
_types = _src("types.ts")
_app = _src("App.vue")
_all_src = "\n".join(
    _src(f) for f in ["App.vue", "db.ts", "edit.ts", "importer.ts", "import.ts",
                      "quiz.ts", "srs.ts", "seed.ts", "backup.ts", "toast.ts",
                      "types.ts", "composables.ts", "flags.ts", "pwa.ts"]
) + _train + _board

d16 += [
    ("目标词高亮仍是实心药丸",
     "mark {" in _style and "background: #fff0b3" in _style),
    ("三件套还在（错题板/手动掌握/随手标记）",
     all(k in _train for k in ["markMastered", "再来一个", "这句有问题"])
     and "错题板" in _board
     # 底栏三个 tab 的文案。训练已从 tab 栏撤掉（它是动作不是地方，见 D36），
     # 所以这里不能再找「训练」—— 否则守卫会靠注释里的词通过，判的是什么就说不清了。
     and "label" not in _app and all(k in _app for k in ["首页", "词库", "更多"])),
    # 泄题守卫：选项的对错色必须由 submitted（真作答）门控，不能由
    # revealed（选项已展开）门控 —— 后者会在你还没选时就把答案染绿。
    # 这条曾经真的漏过一次，所以进机械检查。
    ("答题不泄题：对错色只由 submitted 门控",
     "right: submitted && isRight(opt)" in _train
     and "v-if=\"!revealed\"" in _train
     and "wrong: submitted &&" in _train),
    # tabbar 图标名必须是 Vant 内置图标表里真实存在的。写错不报错、只渲染空白，
    # 而「底栏少一个图标」很难让人联想到是名字拼错了。
    ("tabbar 图标名都在 Vant 图标表里", all(
        _vant_icon_exists(ic)
        for ic in ["wap-home-o", "apps-o", "ellipsis"]) and "icon=\"apps-o\"" in _app),
    # 盯**闭环**而不是某一个函数名。
    # 原来这里断言 `flagSentence` 存在于 edit.ts —— 而那个函数是死代码，
    # 被清掉之后守卫立刻红了，可实际闭环好好地跑：训练页随手标记
    # （quiz.flagQuestion）、错题板标记/关单（flags.ts）、意思页切换标记
    # （SensePage）三处都在写 flagged/flagNote。
    # 一个钉在函数名上的守卫，保的是「别把那个函数删了」，
    # 而不是「标记这件事还通不通」—— 这类守卫迟早和现实脱节。
    ("例句标记闭环还在（三个写入口 + 导出 + 字段）",
     "flagged: 0 | 1" in _types and "flagNote: string" in _types
     and "flagged: 1, flagNote" in _src("quiz.ts")          # 训练页随手标记
     and "flagged: 1, flagNote" in _src("flags.ts")          # 错题板标记
     and "flagged: 0, flagNote" in _src("flags.ts")          # 关单
     and "'word-flags'" in _src("flags.ts")),                # 清单交给内容侧
    ("学习进度挂义项 id（不是 s1/s2）",
     "senseId" in _types and "senseId: string" in _types
     and "progress: 'senseId" in _src("db.ts")),
    ("web 端不依赖服务端 API（离线可用）", "/api/" not in _all_src),
    # Dexie 的 schema 只能追加版本、不能就地改已发布版本：改了就等于
    # 让老用户的库既没有新表、代码又以为有，表现是所有读取静默失败。
    ("Dexie schema 有版本迁移（v1 保留 + v2 追加）",
     _src("db.ts").count("this.version(") >= 2),
    # 已实测会让 WebView 渲染进程崩溃的组件（见 app/web/tests/WEBVIEW-CRASHES.md）。
    # 引入它们 = 用户的 app 直接崩，屏幕停在最后一帧，看起来像「卡死」。
    # 只认模板标签 `<van-dropdown-…>`：注释里提一句「别用 dropdown」不算用。
    ("没用已知崩溃的 Vant 组件（dropdown）",
     not any("<van-dropdown" in _src(os.path.join("pages", p))
             for p in ("HomePage.vue", "WordPage.vue", "SensePage.vue",
                       "LibraryPage.vue", "TrainPage.vue", "BoardPage.vue",
                       "MorePage.vue"))),
    ("崩溃清单在（真机实测记录）",
     os.path.exists(os.path.join(
         PROJ, "app", "web", "tests", "WEBVIEW-CRASHES.md"))),
    ("Dexie 版本升级有回归测试",
     os.path.exists(os.path.join(
         PROJ, "app", "web", "tests", "schema_upgrade.mjs"))),
    ("内容包从文件/种子进 IndexedDB",
     # 导入入口 2026-10 已合并到「更多 → 备份与导入」（按 format 分派），
     # 词库页只留指路，所以判据盯的是 MorePage 里的那个入口 + 种子文件在。
     "onImport" in _src(os.path.join("pages", "MorePage.vue"))
     and os.path.exists(os.path.join(PROJ, "app", "web", "public", "seed.json"))),
    ("SRS 移植一致性测试在",
     os.path.exists(os.path.join(PROJ, "app", "web", "tests", "srs_parity.mjs"))),
    ("数据层端到端测试在",
     os.path.exists(os.path.join(PROJ, "app", "web", "tests", "flow_smoke.mjs"))),
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
    ("问题句关单工具存在", os.path.exists(os.path.join(
        PROJ, "app", "tools", "flags.mjs"))),
    ("server 支持多内容源切换", all(
        w in io.open(os.path.join(PROJ, "app", "server.mjs"), encoding="utf-8").read()
        for w in ("WORD_BUNDLE", "WORD_DB", "bundleUrl"))),
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

# ─────────────────────────────────────────────────────────────
# 真机交互层的机械守卫
#
# 这一组拦的都是「不报错但结果不对」的坑 —— 它们静默到只能靠人记得，
# 所以能机械判定的部分一律写成断言。逐条的完整解释见
# docs/notes/踩坑记录.md
# ─────────────────────────────────────────────────────────────
print("\n=== 真机交互守卫（静默坑，见 docs/notes/踩坑记录.md）===")
import os
import re as _re

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "web")
STYLE = os.path.join(WEB, "src", "style.css")
HOME = os.path.join(WEB, "src", "pages", "HomePage.vue")
TRAIN = os.path.join(WEB, "src", "pages", "TrainPage.vue")
SENSE = os.path.join(WEB, "src", "pages", "SensePage.vue")
WORD = os.path.join(WEB, "src", "pages", "WordPage.vue")
LIB = os.path.join(WEB, "src", "pages", "LibraryPage.vue")
MORE = os.path.join(WEB, "src", "pages", "MorePage.vue")
BOARD = os.path.join(WEB, "src", "pages", "BoardPage.vue")
DRAG = os.path.join(WEB, "src", "draglist.ts")


def _read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except IOError:
        return ""


def _code(p):
    """读源码并**去掉注释**。

    这一步是必须的：这些守卫要判的往往是「某个坏写法还在不在」，
    而修好之后我们会在注释里**引用**那个坏写法来解释坑是什么
    （例如 draglist.ts 里写着「之前是 if (!active || ...) return {}」）。
    不去注释的话正则会匹配到注释，守卫永远 FAIL —— 一个永远失败的守卫
    比没有守卫更糟，因为它会被无视。

    ★ 连**模板里的 HTML 注释**也一起去掉：`.vue` 的模板里满是
    「<!-- 原来这里写的是 content-kit 的 cards.json -->」这类解释，
    它们不渲染、不出现在用户界面上，但守卫在扫源码文本 ——
    不去掉就会把「界面上不许出现内部说法」判成 FAIL。
    判据必须是**渲染出来的东西**，不是源码里写了什么。
    """
    t = _read(p)
    t = _re.sub(r"/\*.*?\*/", "", t, flags=_re.S)
    t = _re.sub(r"//[^\n]*", "", t)
    t = _re.sub(r"<!--.*?-->", "", t, flags=_re.S)     # 模板里的 HTML 注释
    t = _re.sub(r"^\s*\*.*$", "", t, flags=_re.M)   # 块注释的续行
    return t


css = _code(STYLE)
home = _code(HOME)
train = _code(TRAIN)
sense = _code(SENSE)
lib = _code(LIB)
word = _code(WORD)
drag = _code(DRAG)
more = _code(MORE)
board = _code(BOARD)
kb = _code(os.path.join(WEB, "src", "keyboard.ts"))
# 底栏让位写在 App.vue 的 scoped 样式里，不在 style.css —— 别查错文件
appvue = _code(os.path.join(WEB, "src", "App.vue"))
scanlist = _src(os.path.join("components", "ScanList.vue"))
wordpeek = _src(os.path.join("components", "WordPeek.vue"))
lookup_ts = _src("lookup.ts")

# ── 全仓文本扫描（坑 57 与「坑号都得有正文」两条守卫共用）──
# 只收人会写的地方：依赖（node_modules）、派生产物（build/、dist/）、
# 编译缓存（__pycache__）不算「我们写的东西」，那里的乱码不是我们的错。
_TEXT_EXT = (".ts", ".vue", ".mjs", ".js", ".py", ".md", ".json", ".css",
             ".html", ".tsv", ".yaml", ".yml")
_SKIP_DIRS = {"node_modules", "__pycache__", "build", "dist", ".git", ".gradle"}


def _text_files():
    for root, dirs, files in os.walk(PROJ):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for f in files:
            if f.endswith(_TEXT_EXT):
                yield os.path.join(root, f)


def _mojibake_files():
    """含 U+FFFD（也就是乱码方块）的文件 —— 坑 57。

    这**不是**「少了个字」那么容易被发现：它在编辑器里是一个小方块、
    在编译器眼里完全合法、在 JSON/TSV 里也不破坏结构，
    只有读的人才知道坏了。所以判据只能是**扫字节**，靠眼睛不算判据。
    """
    bad = []
    for p in _text_files():
        try:
            if "\ufffd" in io.open(p, encoding="utf-8").read():
                bad.append(os.path.relpath(p, PROJ))
        except (IOError, UnicodeDecodeError):
            bad.append(os.path.relpath(p, PROJ))    # 连 UTF-8 都读不了也算坏
    return bad


def _cited_pitfalls():
    """代码/文档里引用到的坑号（`坑 46`、`坑 45 / 46`、`坑 41、42` 都认）。

    archive/ 不参与：那里的历史文字按当时的编号体系写的，不要求对齐。
    """
    nums = set()
    arc = os.path.join(PROJ, "archive") + os.sep
    for p in _text_files():
        if os.path.abspath(p).startswith(arc):
            continue
        try:
            t = io.open(p, encoding="utf-8").read()
        except (IOError, UnicodeDecodeError):
            continue
        for grp in re.findall(r"坑\s*((?:\d+\s*[、/,，]\s*)*\d+)", t):
            nums |= {int(n) for n in re.findall(r"\d+", grp)}
    return nums


def _documented_pitfalls():
    """踩坑记录里有正文的坑号（`## 46. 标题` 这种标题的编号）。"""
    t = _read(os.path.join(PROJ, "docs", "notes", "踩坑记录.md"))
    return {int(n) for n in re.findall(r"^## (\d+)\. ", t, re.M)}


# ── AI 子系统的判据（D38）──
# 「AI 代码内聚」不是靠自觉：这里直接扫「ai/ 以外有没有外网调用」。
_AI_DIR = os.path.abspath(os.path.join(WEB, "src", "ai"))


def _ai_src(name):
    return _read(os.path.join(_AI_DIR, name))


def _ai_page(name):
    return _read(os.path.join(WEB, "src", "pages", name))


def _non_ai_sources():
    import glob
    files = glob.glob(os.path.join(WEB, "src", "**", "*.ts"), recursive=True) + \
        glob.glob(os.path.join(WEB, "src", "**", "*.vue"), recursive=True)
    return {p: _read(p) for p in files if not os.path.abspath(p).startswith(_AI_DIR)}


def _van_used():
    """模板里用到的 van-* 组件名（转成 PascalCase：van-tabbar-item → TabbarItem）。"""
    import glob
    used = set()
    for p in glob.glob(os.path.join(WEB, "src", "**", "*.vue"), recursive=True):
        for name in re.findall(r"<van-([a-z0-9-]+)", _read(p)):
            used.add("".join(part.capitalize() for part in name.split("-")))
    return used


def _van_registered():
    """vant.ts 里注册过的组件名（import 块里那几个大写开头的标识符）。"""
    t = _read(os.path.join(WEB, "src", "vant.ts"))
    block = re.search(r"import \{([\s\S]*?)\} from 'vant'", t)
    if not block:
        return set()
    return {n.strip() for n in block.group(1).split(",") if n.strip()}




def _code_all():
    """整个 src/ 的代码（去掉注释），用来判「全站都不许有某个写法」。

    必须去注释：修复之后大家会在注释里**引用**坏写法来解释坑是什么
    （如「原生 confirm() 在 WebView 里是系统对话框」），不去注释的话
    守卫会永远 FAIL —— 一个永远失败的守卫比没有守卫更糟，因为它会被无视。
    """
    import glob
    src = os.path.join(WEB, "src")
    files = glob.glob(os.path.join(src, "**", "*.ts"), recursive=True) + \
        glob.glob(os.path.join(src, "**", "*.vue"), recursive=True)
    return "\n".join(_code(p) for p in files)

interaction = [
    # 坑 8：overscroll-behavior 写在 body 上等于没写（默认滚动容器是 html）
    ("overscroll-behavior 写在 html 而非 body",
     _re.search(r"html\s*\{[^}]*overscroll-behavior", css, _re.S) is not None),

    # 坑 9：容器与 sticky 条都加同一份顶部留白 = 叠加成两倍。
    # 真机实测标题落在 84px（应为 46px），只能靠断言拦住。
    # 判据要精确：不是「不能出现 padding-top」（写死 0 是在明示约定），
    # 而是「不能引用安全区变量」—— 引用了就会参与叠加。
    ("顶部留白只算一次（.wb-page 不引用安全区变量）",
     _re.search(r"\.wb-page\s*\{[^}]*padding-top\s*:[^;}]*--(wb-sb-h|wb-safe-top)",
                css, _re.S) is None),
    ("安全区让位确实在 .wb-topbar 上",
     _re.search(r"\.wb-topbar\s*\{[^}]*padding-top", css, _re.S) is not None),

    # 坑 11：overflow-x:hidden 会把另一轴变成 auto，让元素变滚动容器
    #        并废掉 sticky。夹横向溢出必须用 clip。
    ("横向溢出用 clip 而非 hidden",
     "overflow-x: hidden" not in css),

    # 坑 10：根元素/body 上的 overflow 夹不住（会传播给视口），
    #        必须在真正产生溢出的元素上夹。
    ("首页装饰元素自带 overflow-x: clip",
     _re.search(r"\.home\s*\{[^}]*overflow-x:\s*clip", home, _re.S) is not None),

    # 坑 21：可点范围不能挂在整张大卡片上。
    #        首页词卡约 280px 高，整块可点会抢走搜索框和例句里选词的点击。
    ("首页词卡不再整块可点（click 挂在单词上）",
     _re.search(r'class="stage"[^>]*@click', home) is None
     and _re.search(r'class="w"[^>]*@click', home) is not None),

    # 坑 22：键盘基准值必须在收起时也更新，否则只有第一次避让。
    ("键盘避让的基准值无条件回退",
     _re.search(r"if \(kb <= last\) return", kb) is None),

    # 坑 14：渲染期函数里的 || 短路会挡住 ref 读取，导致依赖从未被收集。
    ("computeStyle 没有 || 短路式早退",
     _re.search(r"if \(!active \|\|", drag) is None),

    # 坑 15：作用于 teleport 出去的 van-popup 的规则必须在全局样式里。
    ("弹层键盘让位写在全局样式（style.css）",
     _re.search(r"kb-open\s+\.van-popup", css) is not None),

    # 训练页：四个选项必须两列，否则一屏放不下、用户得翻页才看得到「下一题」
    ("训练页选项是 2×2 网格（保证一屏放得下）",
     _re.search(r"\.opts\s*\{[^}]*grid-template-columns", train, _re.S) is not None),

    # 松手时必须「先改数据再清位移」。反过来（先 reset 再 await 落库）会出现
    # 「行已弹回原位、内容还是旧顺序」的中间帧，真机逐帧采样量到过 50ms 空窗，
    # 快速连续换位时整列看起来在闪。这条纯靠肉眼很难稳定复现，只能写成断言。
    ("松手时先换数据再清位移（不是先 reset）",
     _re.search(r"reset\(\)\s*\n\s*(?://[^\n]*\n\s*)*await onReorder", drag) is None
     and _re.search(r"onReorder\(f, t\)", drag) is not None),
    ("onReorder 开头同步换本地数组",
     _re.search(r"sents\.value\s*=\s*next", _code(SENSE)) is not None
     or _re.search(r"senses\.value\s*=\s*next", word) is not None),

    # 键盘弹起时 fixed 底栏必须让开，否则用户想点 tab 却点到键盘
    ("键盘弹起时底栏让位",
     _re.search(r"kb-open\s+\.fixed", appvue) is not None
     or _re.search(r"kb-open\s+\.fixed", css) is not None),

    # ── 坑 41：避让把元素顶部当基准，差 2px 能滚 300px ──
    # 原式 `scrollY + box.top - overflow - 8`：只被盖住 43px 的输入框会让页面
    # 跳 450px，再被 Math.max(0,…) 悄悄吃掉向上那截 → 「窜到最顶、内容出屏」。
    ("键盘避让只挪被挡住的那一点（不再用 box.top 当基准）",
     _re.search(r"scrollY\s*\+\s*box\.top\s*-\s*overflow", kb) is None),
    ("键盘避让夹住合法滚动区间（不越滚到文档底之外）",
     _re.search(r"scrollHeight\s*-\s*window\.innerHeight", kb) is not None),

    # 坑 23 的补强：弹层里的输入框不滚页面（弹层自己 padding-bottom 让位）。
    # 判的是**聚焦的那个元素**，所以必须出现 el.closest('.van-popup')，
    # 不能只在别处判一下避让目标。
    ("弹层里的输入框不触发页面滚动",
     _re.search(r"el\.closest\(\s*['\"]\.van-popup", kb) is not None),

    # ── 坑 32：数据没到就渲染「找不到」＝闪一下假话 ──
    # 意思页/单词页读库期间必须是骨架屏分支，且 gone/空状态要在 loading 之后。
    ("意思页有 loading 骨架屏（不再闪「找不到」）",
     _re.search(r"v-else-if=\"loading\"", sense) is not None
     and _re.search(r"skel", sense) is not None),
    ("单词页有 loading 骨架屏（不再闪「还没有释义」）",
     _re.search(r'v-if="loading\s*&&\s*!senses\.length"', word) is not None),

    # ── 坑 35：例句必须显式进编辑态 ──
    # 非编辑态不能挂 contenteditable / wb-edit，否则手指一碰就改。
    # （释义 gloss/glossEn/note 仍然是点字即改，那是故意的，别一起改掉。）
    ("例句默认不可改（contenteditable 与 wb-edit 都跟着编辑态走）",
     _re.search(r':contenteditable="isEditing\(s\)"', sense) is not None
     and _re.search(r"[\"']wb-edit[\"']\s*:\s*isEditing\(s\)", sense) is not None),

    # ── 坑 31：全站不许再用原生 confirm()/prompt() ──
    # 原生对话框在 WebView 里顶着 "The page at https://…" 一行、按钮是 CANCEL/OK。
    # 排除 `ev.prompt()`：那是 beforeinstallprompt 事件，跟 window.prompt 无关。
    ("全站没有原生 confirm()/prompt()",
     _re.search(r"(?<![.\w])confirm\s*\(", _code_all()) is None
     and _re.search(r"(?<![.\w])prompt\s*\(", _code_all()) is None),

    # ── 坑 39：顶栏返回不能两页对着来 ──
    # 两页都走 nav.ts 的 goBack（回上一屏 + 兜底），不许再出现裸 router.back()。
    ("顶栏返回统一走 goBack（不含裸 router.back()）",
     _re.search(r"router\.back\(\)", sense + word) is None
     and _re.search(r"function goBack", _code(os.path.join(WEB, "src", "nav.ts"))) is not None),

    # ── 坑 38：拖动把手撑满整行 ──
    # align-self:flex-start 时热区只有顶上二十来 px，两三行高的例句行根本按不准。
    ("例句拖动把手撑满整行并垂直居中",
     _re.search(r"\.sent \.n\s*\{[^}]*align-self:\s*stretch",
                _code(SENSE), _re.S) is not None),

    # ── 坑 33：同路由不同 query 不能靠 onMounted 重置 ──
    # 必须同时盯 solo 与 sent：只盯 solo 的话，从扫读点进来的 sent 会被漏掉，
    # 于是「点哪句猜哪句」退化成随机出这个意思的**另一句**（坑 51）。
    ("训练页按 query 变化重开一轮，且同时盯 solo 与 sent（不是 onMounted）",
     _re.search(r"watch\(\s*\(\)\s*=>\s*\[route\.query\.solo,\s*route\.query\.sent\]",
                train) is not None),

    # ── 坑 42：骨架屏本身也是一次跳变，首帧必须就有内容 ──
    # mount → 渲染第一帧 → await 读库 → 第二帧：第一帧不管渲染什么都是跳变。
    # 解法是首帧从常驻内存的表里同步读（db.ts 的 cachedNow），
    # 并且启动时统一预热，不能靠「用户之前去过哪儿」。
    ("单词页首帧同步读（readyFromMemory）",
     _re.search(r"readyFromMemory", word) is not None),
    ("意思页首帧同步读（readyFromMemory）",
     _re.search(r"readyFromMemory", sense) is not None),
    ("词库页首帧同步出列表（不是先闪「正在读库」）",
     _re.search(r"readyFromMemory", lib) is not None),
    ("首页首帧同步抽卡（randomCardNow）",
     _re.search(r"randomCardNow", home) is not None),
    # 首页那一帧最坏：不是闪个骨架，是**说用户的词库没了**。
    # 「还在读」和「确实没有」必须两个值，模板必须三态。
    ("首页区分「还没读」与「确实为空」（v-else-if）",
     _re.search(r'v-else-if="card\s*===\s*undefined"', home) is not None),
    ("首页的「词库还是空的」只在读完且为空时出现",
     _re.search(r'v-else-if="card === undefined"[\s\S]*?'
                r'v-else[^>]*>\s*<div class="empty">词库还是空的</div>', home) is not None),
    ("首页统计口径也有同步版（loadStatsNow）",
     _re.search(r"loadStatsNow", home) is not None),
    ("抽卡与统计的算法同步/异步共用一份（pickCard/computeStats）",
     _re.search(r"function pickCard", _code(os.path.join(WEB, "src", "composables.ts"))) is not None
     and _re.search(r"function computeStats", _code(os.path.join(WEB, "src", "composables.ts"))) is not None),
    ("db 暴露同步读（cachedNow）",
     _re.search(r"export function cachedNow", _code(os.path.join(WEB, "src", "db.ts"))) is not None),
    ("启动时预热常用表（warmTables）",
     _re.search(r"warmTables\s*\(", _code(os.path.join(WEB, "src", "main.ts"))) is not None),

    # 次要信息宁可晚到也不要假数：例句条数没算出来前不写「0 句」
    ("例句条数没算出来时不显示「0 句」",
     _re.search(r'v-if="countsReady"', word) is not None),

    # ── 轻提示：写死 2000 会被弹层压住，而且不报错 ──
    # Vant 的层号从 2001 起、每挂一个弹层类组件就 ++（use-global-z-index.js），
    # 写死 2000 的 toast 第一次开弹层就被盖住 —— 提示确实弹了，只是看不见。
    ("toast 的 z-index 压过 Vant 弹层（不是写死 2000）",
     (lambda m: m is not None and int(m.group(1)) >= 3000)(
         _re.search(r"\.toast\s*\{[^}]*z-index:\s*(\d+)", appvue, _re.S))),
    # toast 配色跟着 token 走，不再是一块近黑的补丁
    ("toast 配色用设计 token（不再是写死的近黑底）",
     _re.search(r"\.toast\s*\{[^}]*background:\s*var\(--wb-card\)", appvue, _re.S) is not None),
    # 复制成功收弹层（失败留着 —— 提示语要求手动选中，关了就成空话）
    ("复制模板成功后收弹层，失败留着",
     _re.search(r"copyText\(props\.text\)\)\s*\{\s*emit\('close'\)",
                _code(os.path.join(WEB, "src", "components", "PromptSheet.vue"))) is not None),

    # ── 坑 45：固定栏被越界拖动。禁要在滚动容器自己身上，且必须是 none ──
    # contain 只挡「传给别人」，自己照弹；而 Android 上「自己弹」的表现
    # 恰恰是整个窗口被系统拉伸（targetSdk≥31 默认开 crossWindowStretchEffects）。
    ("html 禁橡皮筋用 none（不是 contain）",
     _re.search(r"html\s*\{[^}]*overscroll-behavior:\s*none", css, _re.S) is not None
     and _re.search(r"overscroll-behavior-[xy]\s*:", css) is None),
    # 唯一的内层滚动容器（弹层体）也别留成默认 auto
    ("弹层滚动体也禁橡皮筋（不留默认 auto 的口子）",
     _re.search(r"\.sh-b\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*none",
                _code(os.path.join(WEB, "src", "components", "Sheet.vue")), _re.S) is not None),

    # ── 坑 46：底栏出现在详情页 = 制造了一种错误预期 ──
    # 「底栏」在手机上被读成「和我同级的四个地方」。二级页也摆着它，
    # 用户会以为点另一个 tab 是替换当前页（其实是压一层历史，越点越长）。
    ("二级页收底栏（v-if，不是 v-show）",
     _re.search(r"<van-tabbar\s+v-if=\"showTabs\"", appvue) is not None
     and _re.search(r"v-show=\"showTabs\"", appvue) is None),
    # 收了底栏就要同时收回它占的留白，否则页面底部凭空多一截空白
    ("二级页把底栏高度变量归零（html.no-tabs）",
     _re.search(r"html\.no-tabs\s*\{[^}]*--wb-tabbar-h:\s*0px", css, _re.S) is not None
     and _re.search(r"classList\.toggle\('no-tabs'", appvue) is not None),
    # 留白是在渲染之前改的：晚一帧就是坑 42 那种跳变
    ("改 no-tabs 用 flush:'sync'（赶在渲染前）",
     _re.search(r"flush:\s*'sync'", appvue) is not None),

    # ── 坑 46 同源：清单平铺 = 页面长度不由界面决定 ──
    ("更多页的清单有独立滚动框（不随数据量变长）",
     (lambda t: len(_re.findall(r'class="cap-list"', t)) == 3)(_code(MORE))),
    # 清单框限高。overscroll-behavior-y 必须是 **auto**（允许滚动传递到页面），
    # 不能是 none —— none 把传递一起禁掉，清单滑到头再拖页面也不动了，
    # 用户被卡在 236px 的小框里（实测清单只多 52px，一拖就撞墙）。
    # 橡皮筋仍然不会来，因为**文档**那边是 none（D34）—— 传递 ≠ 橡皮筋。
    ("清单框限高且允许滚动传递（auto 而非 none）",
     _re.search(r"\.cap-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto[^}]*"
                r"overscroll-behavior-y:\s*auto", more, _re.S) is not None),
    # 弹层里的框相反：它下面隔着一层遮罩，传递过去会拖动背后的页面，必须 none。
    # 这两条同时断言，是为了让「什么时候该 none、什么时候该 auto」不再靠记忆。
    ("弹层里的框仍禁传递（下面隔着遮罩，不能拖动背后的页面）",
     _re.search(r"\.sh-b\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*none",
                _code(os.path.join(WEB, "src", "components", "Sheet.vue")), _re.S) is not None),
    # 被裁掉多少是看不见的，所以条数要写在滚动框**外面**
    # 三条列表合进了 SwipePanels，条数由它的分段标题带（同样在滚动框外面）；
    # 三个面板必须**同时渲染**，否则切过去先见空面板（坑 42）。
    ("三个记录列表平级，条数写在滑动框外",
     (lambda t: len(_re.findall(r"key:\s*'(snap|import|trash)'", t)) == 3
      and "count: snaps.value.length" in t
      and "count: imports.value.length" in t
      and "count: trash.value.length" in t)(more)
     and _re.search(r"p\.count\s*!=\s*null",
                    _code(os.path.join(WEB, "src", "components",
                                       "SwipePanels.vue"))) is not None),
    ("滑动容器不做懒加载（v-for 全量渲染）",
     _re.search(r'<div v-for="p in panels"[^>]*class="pane"',
                _code(os.path.join(WEB, "src", "components", "SwipePanels.vue"))) is not None),
    # touch-action: pan-y 少了它，横向手势被浏览器抢走 —— 最常见的一条
    ("滑动容器 touch-action: pan-y（横向手势不被浏览器抢走）",
     _re.search(r"touch-action:\s*pan-y", _code(os.path.join(
         WEB, "src", "components", "SwipePanels.vue"))) is not None),
    # ★ 坑 50：面板宽度不能写 `flex: 0 0 100%`
    # 那个 100% 解析的是**轨道**（N × 视口），不是视口 ——
    # 于是每个面板都 N 倍宽、2/3 屏被推出可视区，而切换只平移一个视口宽，
    # 结果**每一页看到的都是第一页的中间一段**。数据都在、功能都在，只是错位。
    ("滑动面板宽度是 100%/N，不是 100%（百分比相对 flex 容器）",
     _re.search(r"\.pane\s*\{[^}]*width:\s*calc\(100%\s*/\s*var\(--n",
                _code(os.path.join(WEB, "src", "components",
                                   "SwipePanels.vue")), _re.S) is not None
     and _re.search(r"\.pane\s*\{[^}]*flex:\s*0\s+0\s+auto", _code(os.path.join(
         WEB, "src", "components", "SwipePanels.vue")), _re.S) is not None),

    # ── 坑 47：存下来的格式和解析器对不上，就静默少说一句话 ──
    # 「改」「冲突」后面没有加号（`词+18 义+66 改0 句+33 冲突0`），
    # 按 key+N 一刀切就永远漏掉；AI 那套（`新增义项0 例句10`）又不是同一个格式。
    ("导入历史两种 summary 格式都认（加号可选 + 认不出就原样用）",
     r"\\+?(" in _code(os.path.join(WEB, "src", "backup.ts"))
     and _re.search(r"else\s*\{\s*parts\.push\(r\.summary\)",
                    _code(os.path.join(WEB, "src", "backup.ts")), _re.S) is not None),
    ("importLine 有测试钉住（flow_smoke 7b）",
     "importLine" in _read(os.path.join(WEB, "tests", "flow_smoke.mjs"))),

    # ── 坑 48：导入是一个入口，按 format 分派 ──
    # 用户手上只有一个 .json，不该需要先判断它是内容包还是备份。
    ("导入按 format 分派（classifyImport）",
     _re.search(r"export function classifyImport",
                _code(os.path.join(WEB, "src", "import.ts"))) is not None
     and "classifyImport" in more),
    # 认不出时要说清「它是什么、期望什么」，不给「跳过 N 处」这种像部分成功的话术
    ("认不出的文件给明确说明，不报「恢复完成」",
     _re.search(r"export function unknownFormatText",
                _code(os.path.join(WEB, "src", "import.ts"))) is not None
     and _re.search(r"unknownFormatText\(format\)", more) is not None),
    # 词库页那个重复的「导入内容包」入口必须退场（同一件事只能有一个入口）
    ("词库页不再有第二个导入入口",
     _re.search(r"导入内容包", lib) is None
     and _re.search(r"importPack", lib) is None),
    # 三条导入路径都要能回滚：内容包原本不存快照
    ("内容包导入前也存快照（三条路径回滚能力一致）",
     _re.search(r"await snapshot\(", _code(os.path.join(WEB, "src", "import.ts"))) is not None),

    # ── 坑 49：事件的接收方必须常驻 ──
    # 监听器挂在某个页面的 onMounted 上 ⇒ 用户在别的路由打开文件时事件进虚空，
    # 「点了那个文件什么都没发生」且无日志。
    ("wb:import-file 的监听在 App.vue（永远挂着），不在页面里",
     _re.search(r"addEventListener\('wb:import-file'", appvue) is not None
     and _re.search(r"addEventListener\('wb:import-file'", more) is None),
    ("处理方改成 watch bridge.incomingFile",
     "incomingFile" in more and "watch(incomingFile" in more),

    # ── 主操作不能藏在滚动区下面 ──
    ("复制按钮在 Sheet 的 footer 槽（不随内容滚走）",
     _re.search(r"template #footer", _code(os.path.join(WEB, "src", "components",
                                                             "PromptSheet.vue"))) is not None
     and _re.search(r'<template #footer>', appvue) is None),

    # ── 界面上不许出现数据字段的内部写法 ──
    # `s1` 那个 s 是 senseId 的前缀，不是任何缩写；用户无从理解，
    # 而它同时还是拖动把手 —— 用户看到的是一块看不懂的标签，还要按住它拖。
    ("界面里不出现 s1/s2 式的编号（只剩内部 key）",
     _re.search(r"s\{\{\s*\w+\.slot", more + word + sense + train + board + _read(
         os.path.join(WEB, "src", "components", "ImportSheet.vue"))) is None
     and _re.search(r">s\{\{", more + word + sense + train + board + _read(
         os.path.join(WEB, "src", "components", "ImportSheet.vue"))) is None),
    # 同一个概念曾经有四种说法：意思 / 义项 / 个意思 / nSenses
    ("用户界面上统一叫「意思」，不用「义项」",
     all(_re.search(r"义项", t) is None
         for t in [more.replace("义项级（词库页那个是词级）", "")])),
    ("序号牌是两页一致的圆形浅底",
     _re.search(r"\.slot i\s*\{[^}]*border-radius:\s*50%", word, _re.S) is not None
     and _re.search(r"\.slot\s*\{[^}]*border-radius:\s*50%", sense, _re.S) is not None),

    # ── 界面术语不许混进开发者语言 ──
    # 「content-kit 的 cards.json」出现在用户界面上只会让人一头雾水；
    # 具体格式归 CONTRACT.md，界面只说「这是什么文件、进来会怎样」。
    ("更多页不出现 content-kit / cards.json / TSV 这类内部说法",
     all(w not in more for w in ["content-kit", "cards.json", "TSV"])
     and all(w not in lib for w in ["content-kit", "cards.json"])),

    # ── 背完之后不能无事可做 ──
    # 「再来一轮」原来重新按到期组队列，而刚答过的卡 dueAt 已挪到明天、
    # reps>0 —— 于是点它等于什么也没发生。
    ("「再来一遍」重刷本轮自己的卡（不是重新按到期组队列）",
     _re.search(r"@click=\"start\('redo'\)", train) is not None
     and "lastRound" in train
     and _re.search(r"which === 'redo'", train) is not None),
    ("有「随便练」：全库随机，不看到期",
     _re.search(r"export async function buildRandomQueue", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None
     and _re.search(r"start\('random'\)", train) is not None),
    ("有「扫读」：报纸式多行例句，点哪句猜哪句（就地显示，不跳页）",
     _re.search(r"export async function scanBatch", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None
     and _re.search(r'@click="emit\(.drill., it\)"', scanlist) is not None
     and _re.search(r"sent:\s*String\(it\.sentence\.id\)", train) is not None
     # 不许再单独存在一个扫读页面 —— 「藏得深」本身就是要去掉的东西
     and not os.path.exists(os.path.join(WEB, "src", "pages", "ScanPage.vue"))
     and not _re.search(r"router\.push\('/scan'\)", _all_src)),
    # 点了哪句就必须出哪句：pin 参数要一路传到 makeQuestion
    ("点哪句就出哪句（pin 一路传到 makeQuestion）",
     _re.search(r"makeQuestion\([\s\S]*pinnedSentence\.value", train) is not None
     and _re.search(r"pinSentence\?: number", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None),
    # watch 必须同时盯 solo 和 sent —— 只盯 solo 会把 sent 漏掉
    ("路由 watch 同时盯 solo 与 sent（坑 51）",
     _re.search(r"watch\(\(\)\s*=>\s*\[route\.query\.solo,\s*route\.query\.sent\]",
                train) is not None),

    # ── 加词入口必须常驻，而且只有一条建词路径 ──
    ("词库页有常驻的「新增词」入口",
     _re.search(r"showAdd\s*=\s*true", lib) is not None
     and _re.search(r"AddWordSheet", lib) is not None),
    ("建词只有一个函数（addWord），校验收在里面",
     _re.search(r"export async function addWord", _code(
         os.path.join(WEB, "src", "edit.ts"))) is not None
     and "addWord" in _code(os.path.join(WEB, "src", "edit.ts"))),
    # addSense 对不存在的词必须先建词条：原来 db.words.update 是静默 no-op，
    # 于是留下一条没有词条的孤儿意思（音标永远空、备份也导不出来）
    ("addSense 先建词条，不靠 update 的静默 no-op",
     _re.search(r"const w = await db\.words\.get\(word\)", _code(
         os.path.join(WEB, "src", "edit.ts"))) is not None),
    # 「不在库里」和「没有释义」是两件事，空态必须分开说
    ("单词页区分「不在库里」与「没有释义」",
     _re.search(r"inLibrary\s*\?\s*'这个词还没有释义'\s*:\s*'这个词还不在词库里'",
                word) is not None),

    # ── 坑 52：写好了却没接上，「学完就忘」就从来没发生过 ──
    # decayIfIdle 存在但没人调用 → rusty 永远是 0 →
    # `if (p.mastered && !p.rusty) return` 恒成立 → mastered 的词永远消失。
    # 判据不能是「这个函数被调用了」（那是形状），只能是接在队列上 + 做了字段适配。
    ("闲置衰减接在组队列上（mastered 的词会回来）",
     _re.search(r"async function decayIdle[\s\S]*?const rows = await decayIdle\(",
                _code(os.path.join(WEB, "src", "quiz.ts"))) is not None),
    ("衰减做了字段适配（库的 lastReview ↔ srs 的 last_review）",
     _re.search(r"last_review:\s*p\.lastReview", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None),
    # 衰减写库必须在事务里，否则 IndexedDB 直接 NotFoundError（坑 25）
    ("衰减的写库在事务内",
     _re.search(r"db\.transaction\('rw',\s*db\.progress",
                _code(os.path.join(WEB, "src", "quiz.ts"))) is not None),
    # 真正守住它的是**行为测试**：守卫判不了「衰减有没有生效」
    ("衰减有行为测试（flow_smoke 里断言它真的回到队列）",
     "闲置超过" in _read(os.path.join(WEB, "tests", "flow_smoke.mjs"))),

    # ── 坑 53：别给「已经缓存着的表」再套一层缓存 ──
    # 义项数以前有个自己的 Map，配一个从没被调用的 clearSenseCache；
    # 合并/拆分之后数就一直是老的，而它会喂给 SRS 的 n_senses。
    # 现在直接数常驻内存的 liveSenses —— 随 senses 写入钩子失效，不可能过期。
    ("义项数不再另建缓存（直接数常驻的 liveSenses）",
     _re.search(r"export function senseCount[\s\S]*?cachedNow<Sense\[\]>\('liveSenses'\)",
                _code(os.path.join(WEB, "src", "quiz.ts"))) is not None
     and "nSenseCache" not in _code(os.path.join(WEB, "src", "quiz.ts"))),
    # 反过来守：全仓不该再有「导出了但没人调用」的清缓存函数
    ("全仓没有只导出不调用的 clear*Cache",
     not _re.search(r"export function clear\w*Cache", _all_src)),

    # ── 清零学习进度：只能碰 progress，流水是历史 ──
    ("重新学一个意思只清 progress，不删 reviewLog",
     _re.search(r"export async function resetProgress[\s\S]*?db\.progress\.put"
                r"[\s\S]*?\n\}", _code(os.path.join(WEB, "src", "edit.ts"))) is not None
     and "reviewLog.delete" not in _code(os.path.join(WEB, "src", "edit.ts"))),
    # 它清掉的是「用户最不该被误触清掉」的数据，必须走确认弹层（D33）
    ("清零学习进度走确认弹层（不是点了直接清）",
     _re.search(r"function onResetProgress\(\): void \{[\s\S]*?ask\.value\s*=",
                sense, _re.S) is not None
     and _re.search(r'@click="onResetProgress"', sense) is not None),
    ("重新学有行为测试（flow_smoke 7d）",
     "resetProgress" in _read(os.path.join(WEB, "tests", "flow_smoke.mjs"))),

    # ── 两条导入路径共用写入原语，策略各留各的 ──
    # 各自写一遍的后果已经发生过：只有一条会存快照、只有一条把 importLog
    # 记在事务内（违反坑 25）、Progress 的十字段抄了两份、summary 两种格式
    # 导致列表里少说话（坑 47）。
    ("两条导入路径共用 importWrite 的写入原语",
     all(_re.search(r"from\s+'\./importWrite'", _src(f)) is not None
         for f in ("import.ts", "importer.ts"))
     and os.path.exists(os.path.join(WEB, "src", "importWrite.ts"))),
    # 事务必须经由原语（表集含 importLog，少一张就会 scope 报错）
    ("两条路径的事务都走 runImportTx（含 importLog）",
     not _re.search(r"db\.transaction\('rw',\s*db\.words", _src("import.ts"))
     and not _re.search(r"db\.transaction\('rw',\s*db\.words", _src("importer.ts"))
     and _re.search(r"db\.transaction\('rw',\s*\.\.\.TABLES",
                    _src("importWrite.ts")) is not None
     and "db.importLog" in _src("importWrite.ts")),
    # importLog 只能在事务里记（坑 25）
    ("没有在事务外直接写 importLog",
     not _re.search(r"\}\)\s*\r?\n\s*await db\.importLog\.add",
                    _src("importer.ts"), _re.S)
     and not _re.search(r"\}\)\s*\r?\n\s*await db\.importLog\.add",
                        _src("import.ts"), _re.S)),
    # Progress 的十字段只许在 importWrite 里出现（别再手写第二份）
    ("Progress 的十字段只在 importWrite 与 resetProgress 里",
     (lambda a, b, c, d: (a.count("difficulty: 8") <= 1 and b.count("difficulty: 8") <= 1
                          and c.count("difficulty: 8") == 0))(
         _src("importWrite.ts"), _src("edit.ts"), _src("import.ts"), _src("importer.ts"))),
    # summary 两种格式仍共存 —— 读的那边必须同时认得（坑 47）
    ("读侧仍同时认两种 summary 格式（importLine）",
     _re.search(r"else\s*\{\s*parts\.push\(r\.summary\)",
                _src("backup.ts"), _re.S) is not None),
    # ── 训练不再是 tab；底栏只有三个 ──
    # 「训练」是一个动作不是一个地方，摆在 tab 栏里是分类错误。
    # 断言**声明处**（路由表）与**渲染处**（模板里的 tab 项）都要改：
    # 只改一处就会出现「meta 说不是 tab、模板里还画着」——
    # 而 meta.tab 只控制整条栏显不显示，不会过滤掉里面的项（真机踩过）。
    ("训练不再是 tab（路由表里没有 meta.tab）",
     _re.search(r"path:\s*'/train'[^}]*\}\s*,", _src("main.ts")) is not None
     and _re.search(r"path:\s*'/train'[^}]*meta:\s*\{", _src("main.ts")) is None),
    ("底栏只画三项（没有训练）",
     len(_re.findall(r"van-tabbar-item\s+name=", appvue)) == 3
     and 'name="train"' not in appvue),
    # 正好三个 tab 页声明了 meta.tab —— 加 tab 时会被这条拦住去补声明
    ("恰好三个路由声明了 meta.tab",
     _code(os.path.join(WEB, "src", "main.ts")).count("meta: { tab: true }") == 3),
    # 训练从首页进、盖满全屏，所以必须有返回（顶栏箭头 = 系统返回键）
    ("训练页有返回箭头（不再是 tab 就得给自己一条退出路径）",
     'name="arrow-left"' in train and "goBack" in train
     # 标题现在由 headerTitle 统一给（单挑 / 复习到期 / 学新词 / 在学的 / 练习）
     and "headerTitle" in train and "{{ headerTitle }}" in train),
    # 「按计划」没有得练时置灰，而不是点进去才发现是空的
    ("「按计划」没得练时置灰（不点进去才发现）",
     _re.search(r"disabled:\s*dueCount\.value\s*===\s*0", train) is not None
     and _re.search(r"m\.disabled", _code(os.path.join(
         WEB, "src", "components", "ModePicker.vue"))) is not None
     and not _re.search(r"换个练法试试", train)),

    # ── 坑 54：用呈现状态去推断作答状态 ──
    # 「我不会」把 submitted 置 true 而 revealed 一直 false，
    # 于是 `v-else-if="!revealed"` 永远命中 —— 「下一题」那个分支到不了，
    # 答案记进了 SRS 而界面上一点反馈都没有，用户被卡在这一题上。
    ("作答状态压过呈现状态（坑 54）",
     _re.search(r'v-else-if="!submitted\s*&&\s*!revealed"', train) is not None
     and _re.search(r'<template v-if="submitted">', train) is not None
     and _re.search(r'v-if="reviewing\s*&&\s*!submitted"', train) is not None),

    # 扫读是**训练页下面的一节**，不是第三种练法、也不是另一个页面。
    # 之前它用 `mode === 'scan'` 霸占整屏：进扫读就把「今天练什么」顶掉，
    # 看着就是另一个页面，而且想回去得先记住返回在哪。
    ("扫读是训练页下面的一节（不是独立页面）",
     _re.search(r"<ScanList\s+@drill=\"onScanDrill\"\s*/>", train) is not None
     and "mode === 'scan'" not in _code(os.path.join(WEB, "src", "pages", "TrainPage.vue"))
     and not os.path.exists(os.path.join(WEB, "src", "pages", "ScanPage.vue"))),
    # 封装归 ScanList：自己取句子、自己换一批、自己管空/加载态
    ("扫读封装在 ScanList 组件里",
     _re.search(r"await scanBatch\(BATCH, undefined, skip\.value\)", scanlist) is not None
     and _re.search(r'<section class="scan">', scanlist) is not None),
    # 行号/句子共用同一个行高（对齐不靠碰运气）
    ("扫读行两列共用行高（对齐不靠碰运气）",
     "--scan-lh" in scanlist
     and len(_re.findall(r"line-height:\s*var\(--scan-lh\)", scanlist)) == 2),
    # 「换一批」在标题行：放列表末尾时它的位置 = 列表高度，一换行就跳
    ("扫读「换一批」在标题行（不随列表高度抖）",
     _re.search(r'<header class="head">.*?换一批', scanlist, _re.S) is not None
     and not _re.search(r"\.scanbtns", scanlist)),
    # 真实语料里的句子不长那样：不挂词性标签（n. / v. / adj.）
    ("扫读列表不挂词性标签（真实句子不长那样）",
     not _re.search(r'class="pos"', scanlist) and not _re.search(r"\.pos\s*\{", scanlist)),

    # ── 发现问题要能当场改，而不是「记录一下以后再说」 ──
    # 发现内容有问题的那一瞬间，正是手里有这个具体句子/选项的那一瞬间。
    # 送到另一个页面去改 = 让人自己把这个句子找回来；找不回来，
    # 于是只剩「有问题的句子继续出现在练习里」。这两个能力差的就是这段路。
    #
    # ★ 而且只能有**一个**入口、不限制改什么、不限制什么时候：
    #   - 分成「改例句 / 改选项」两个入口 → 用户得先归类问题属于哪一类才找得到；
    #   - 塞进选项按钮里 → 四个选项各挂一个「改」，用户得先在心里挑出哪条不对；
    #   - 只在答完后出现 → 坏内容先把你考一次，才轮到你改它。
    ("训练时能当场改内容",
     _re.search(r'<button class="fixrow" type="button" @click="openFixOptions">', train) is not None
     and "QuickEdit" in train),
    # 干扰项：同词性随机抽，且**同一个词的义项明显更常出现**。
    #   - 跨词干扰项「一眼就看出不是这个词的意思」，练不到东西；
    #   - 同词干扰项都像答案，只能靠「这句话是哪个意思」区分 —— 那才是要练的。
    #   句子已经把义项钉死，所以它们不是第二个正确答案，是贴着答案的干扰。
    ("干扰项只取同词性",
     _re.search(r"async function buildOptions[\s\S]{0,900}!sense\.pos \|\| s\.pos === sense\.pos", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None),
    ("同词的义项明显更常被抽中",
     _re.search(r"shuffle\(samePosSameWord\)\s*\n?\s*\.slice\(0, 2\)", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None),
    # 干扰项是借来的内容：跨词的改了会毁别人的卡，同词的改了会在你没看着的卡上动手
    ("选项没有来源字段（借来的内容不该可改）",
     "optionSources" not in _all_src),
    # 「改」只能改真正属于内容的东西：例句 + 本题正确答案的释义
    ("「有问题？改」只列内容（例句 + 正解释义）",
     _re.search(r"fixSenses\.value = \[qq\.sense\]", train) is not None
     and _re.search(r"fixSents\.value = \[qq\.sentence\]", train) is not None),
    # 不挑时机：入口不能被 `submitted` 之类的状态挡住
    ("改的入口不挑时机（答题前就能改）",
     not _re.search(r'v-if="submitted"[^>]*class="fixrow"|class="fixrow"[^>]*v-if="submitted"', train)),
    # 「改」和「核」是两件事：改 = 我确定错了（原地改）；核 = 我想看看
    # （跳详情）。两个都要有，但跳转必须**原样回来**：跳一次丢一轮，
    # 之后就没人敢跳了核验这条路等于不存在。
    ("训练页能被 keep-alive 留着（跳去核验不丢进度）",
     'defineOptions({ name: \'TrainPage\' })' in train
     and _re.search(r'<KeepAlive\s+:include="\[.TrainPage.\]">', appvue) is not None
     and _re.search(r"onActivated\(\(\)\s*=>\s*\{[\s\S]{0,80}void loadQ\(\)", train) is not None),
    ("能跳去核验（意思详情 / 词条）",
     _re.search(r"function goSensePage\(\)", train) is not None
     and _re.search(r"router\.push\(`/sense/\$\{id\}`\)", train) is not None
     and _re.search(r"router\.push\(`/word/\$\{encodeURIComponent\(w\)\}`\)", train) is not None),
    # 题目内容永远从库里重建：内存里那个对象改完就是旧的，
    # 而「明明存上了，回头一看还是错的」比不能改更劝退人。
    ("题目内容每次从库里重建（不拿内存旧对象）",
     _re.search(r"const fresh = await makeQuestion\(step\.q\.sense\.id", train) is not None
     and _re.search(r"let question: Question \| null = await makeQuestion\(", train) is not None),
    # 改完立刻回到原题，否则用户不知道到底存没存上
    ("改完立刻回到原题（看得见才敢信存上了）",
     _re.search(r"async function onEdited\(\)[\s\S]{0,240}await loadQ\(\)", train) is not None),

    # 错题板就是「词 + 释义」= 这道题的答案本身。
    # 放在出题的地方，入口再小也会被当成「先看一眼再答」——
    # 那一轮测的就不再是记忆，而是「你能不能忍住不看」。
    # 复习错题是对的，但要换个语境：它属于「词库」，不属于「考试中」。
    ("训练页里没有错题板入口（考试中不看答案）",
     "/board" not in _code(os.path.join(WEB, "src", "pages", "TrainPage.vue"))),
    ("错题板挂在词库上（复习语境，不是考试语境）",
     _re.search(r"router\.push\('/board'\)", _code(os.path.join(
         WEB, "src", "pages", "LibraryPage.vue"))) is not None),

    # ── 坑 55：多根节点的组件，收不到父组件传下来的 class ──
    # MarkedText 原来是三个并列分支（span / 文本+mark / 文本），属于多根节点。
    # Vue 没法把 class 挂上去，只会警告一声，**界面上照旧渲染**——
    # 于是调用方写的 class="tx" 静默失效，扫读页的行号/句子对不齐，
    # 根子是句子被拆成「文本 + <mark>」两个匿名 flex item 各自排版。
    # 静默失效是最贵的一种坏：不报错、有时看着还行、换个父容器就塌。
    ("MarkedText 有唯一根元素（class 才挂得上）",
     _re.search(r"<template>.*?<span class=\"wb-marked\">.*?</template>",
                _src(os.path.join("components", "MarkedText.vue")), _re.S) is not None),
    # 同名就是同一个东西：答案区那两个按钮原来也叫 .line，
    # 于是「flex-wrap: wrap」漏到扫读的行上，句子被挤到第二行
    # （真机量到偏差正好 = 行高 22.5 + gap 9 = 31.5px，一行都不差）。
    ("同名 CSS 不会合并出想要的结果（坑 56）",
     _re.search(r'class="markrow"', train) is not None
     and not _re.search(r"\.line\s*\{[^}]*flex-wrap", _code(os.path.join(
         WEB, "src", "pages", "TrainPage.vue")), _re.S)),

    # ── 坑 57：写入被截断的汉字，会静默变成一串乱码方块 ──
    # 这条坑是**工具链**的，不是业务的：一次写入若把某个汉字切在字节边界上，
    # 它落盘就成了 U+FFFD。此后：TypeScript 编译正常、JSON 解析正常、
    # 测试全绿、界面只是「有个方块」—— 我审过好几遍都没看见。
    # 全仓扫一遍是唯一可靠的判据（成本约一秒）。
    ("源码/文档/词库里没有乱码方块（坑 57）", not _mojibake_files()),

    # 坑 0 的索引是这本文档的导航，也最容易过期：新写一条坑忘了进索引，
    # 索引就开始骗人。所以判据不是「索引全不全」（比不出来），而是
    # **代码里引用到的坑号，正文里必须有那一节** —— 引用一处、正文缺一节，
    # 读者就只能看到「坑 56」这四个字，然后找不到 56 是什么。
    ("引用到的每个「坑 N」都有正文（坑 0 的索引不骗人）",
     not (_cited_pitfalls() - _documented_pitfalls())),

    # ── 坑 58：keep-alive 缓存的是组件状态，「再进一次」不等于重开一轮 ──
    # 训练页被 KeepAlive 留着（D36：跳去核验不丢这一轮）。
    # 代价是「从首页点去训练」与「刚才那一轮」是同一个组件实例：
    # 不显式重置，用户再进来看到的就是上一轮的结算屏，而屏幕上没有
    # 任何东西告诉他还能练。判据是 onActivated 里那段重置在不在。
    ("再进训练不会端出上一轮的结算屏（坑 58）",
     _re.search(
         r"if \(phase\.value === 'done' && !route\.query\.solo\) \{[\s\S]{0,160}phase\.value = 'playing'",
         train) is not None),

    # ── 系统返回键要先关浮层，而不是退页（D33 的延伸）──
    # 浮层没有自己的历史条目，Android 的返回键会直接把 WebView 退一层 ——
    # 用户的感受是「我关个弹层，结果题没了 / 页面跳走了」。
    # Vant popup 的 close-on-popstate 干的就是这件事（开时压一条历史，
    # 返回时关掉并吃掉这次后退）。判据是四个承载浮层的地方都开着它。
    ("浮层能被系统返回键关掉（close-on-popstate）",
     "close-on-popstate" in _src(os.path.join("components", "WordPeek.vue"))
     and "close-on-popstate" in _src(os.path.join("components", "Sheet.vue"))
     and "close-on-popstate" in _src(os.path.join("components", "QuickEdit.vue"))
     and _re.search(r'<van-popup :show="pickBox"[^>]*close-on-popstate', train) is not None),

    # ── 答完之后才许查词（D37）──
    # 这道题问的就是「这个词在这句话里是什么意思」。答之前把词义摊开，
    # 测的就不是记忆，而是「你能不能忍住不看」。所以判据是**绑定位置**：
    # `pickable` 必须绑 submitted，处理函数里再挡一道 —— 两处都要：
    # 只写模板的话，别处调用同一条路就绕过；只写函数的话，句子一直是可点的。
    ("查词只在作答之后（pickable 绑 submitted + 处理函数再挡一次）",
     _re.search(r':pickable="submitted"', train) is not None
     and _re.search(
         r"function onPickToken\(tok: string\): void \{\s*\n\s*if \(!submitted\.value\) return",
         train) is not None),
    # 浮层必须给三条路：进义项详情、进词条整页、把没入库的词加进来
    ("点词浮层能进详情，也能顺手把生词加入词库",
     '<WordPeek' in train
     and _re.search(r"router\.push\(`/sense/\$\{id\}`\)", wordpeek) is not None
     and _re.search(r"router\.push\(`/word/\$\{encodeURIComponent\(title\.value\)\}`\)",
                    wordpeek) is not None
     and "addPendingWord(" in wordpeek),
    # 占位义项必须标「需精修」：空壳混进复习池就是一张永远学不会的卡
    ("顺手加入的词条是占位义项（needsRefine=1，不许静默混进复习池）",
     _re.search(r"export async function addPendingWord", _code(
         os.path.join(WEB, "src", "edit.ts"))) is not None
     and _re.search(r"addWord\(w\)[\s\S]{0,240}needsRefine: 1", _code(
         os.path.join(WEB, "src", "edit.ts"))) is not None),
    # 虚词不给「加入词库」：否则词库里会多出 the / of / was 这种垃圾
    ("虚词不给加入入口",
     _re.search(r'v-if="!peek\.stop && !justAdded"', wordpeek) is not None
     and "STOP" in lookup_ts),
    # 形态还原必须**验证候选真的在词库里**，不能只按规则拼
    ("形态还原只采信词库里真有的候选（猜错不带偏）",
     _re.search(r"for \(const c of candidates\) \{\s*\n\s*if \(byWord\.has\(c\)\)",
                lookup_ts) is not None),

    # ── AI 接入（D38）：内聚、可换、省钱、不越权 ──
    # 这五条合起来就是「AI 只是可选增强」这个承诺的机械形态：
    # 代码集中、结果只能提议、花钱花在刀口上、密钥不出本机、没有它也能用。
    ("AI 代码只在 ai/ 里（别处不直连外网）",
     not any("Authorization" in t or "chat/completions" in t for t in _non_ai_sources().values())),
    ("AI 只提议不写库（写库只走 ai/apply → edit 原语）",
     _re.search(r"db\.(senses|sentences|words|progress)\.(put|add|update|delete|bulk)",
                _ai_src("actions.ts")) is None
     and "from '../edit'" not in _ai_src("actions.ts")
     and "from '../edit'" in _ai_src("apply.ts")),
    ("AI 的建议必须绑定到真实行（幻觉不落库）",
     "parseProposals(" in _ai_src("actions.ts")
     and _re.search(r"bySlot\.get", _ai_src("parse.ts")) is not None
     and _re.search(r"sentenceHasWord\(", _ai_src("parse.ts")) is not None),
    ("同样的内容不重复花钱（缓存键含内容指纹与模型名）",
     "hashOf(" in _ai_src("actions.ts")
     and "JSON.stringify(ctx)" in _ai_src("actions.ts")
     and "cfg.model" in _ai_src("actions.ts")
     and "cached: true" in _ai_src("actions.ts")),
    ("API Key 只在构建机上，不进备份",
     "apiKey" not in _src("backup.ts") and "apiKey" not in _src("importWrite.ts")
     and "localStorage" in _ai_src("config.ts")),
    ("手机端走原生网络（WebView 里 fetch 会被 CORS 拦）",
     "httpPost" in _read(os.path.join(PROJ, "app", "android", "app", "src", "main",
                                     "java", "com", "wordbank", "app", "NativeBridge.java"))
     and "evalJs" in _read(os.path.join(PROJ, "app", "android", "app", "src", "main",
                                       "java", "com", "wordbank", "app", "MainActivity.java"))
     and "__wbHttp" in _ai_src("transport.ts")),
    ("没配 AI 时入口不出现（不是点进去才说要配）",
     _re.search(r'v-(?:else-)?if="aiOn', word) is not None
     and _re.search(r'v-if="aiOn"', sense) is not None
     and "aiReady" in _ai_page("WordPage.vue")
     and "aiReady" in _ai_page("SensePage.vue")),
    ("AI 一次改多条前先打快照（人才可能整批退回）",
     _re.search(r"await snapshot\(", _ai_src("apply.ts")) is not None),
    ("换例句必须重算高亮区间（否则高亮打在别的词上）",
     "export async function replaceSentence" in _code(os.path.join(WEB, "src", "edit.ts"))
     and _re.search(r"locate\(text, sen\.form\)", _code(
         os.path.join(WEB, "src", "edit.ts"))) is not None),
    # 空壳词走「补全」、有内容的走「审查」：对已有正经释义的词做「补全」，
    # AI 会试图重写已经有主的内容（那是审查的活，且审查也只出提案）。
    ("空壳词走「补全」、有内容的走「审查」",
     _re.search(r"export async function fillWord", _ai_src("actions.ts")) is not None
     and _re.search(r"rows\.senses\.every\(\(s\) => !s\.gloss\.trim\(\)\)", _ai_src("actions.ts")) is not None
     and _re.search(r"const hollow = computed", word) is not None
     and "runFill(" in word),
    # 新义项没有 id/slot，所以它的例句必须**跟着义项一起提**，落库时再挂上去。
    # 分成两条提案的话，parse 绑不到 slot，例句会被丢掉 —— 而且不报错。
    ("新义项自带的例句跟义项一起提、一起落库",
     "sentences?: { en: string; zh?: string }[]" in _ai_src("types.ts")
     and _re.search(r"rawSents\.slice\(0, 3\)", _ai_src("parse.ts")) is not None
     and _re.search(r"for \(const s of p\.sentences", _ai_src("apply.ts")) is not None),

    # ── 用到的 Vant 组件必须注册过（坑 52 的同族）──
    # 这个 app 的组件是**手动按需注册**的（vant.ts），漏注册不报错：
    # Vue 只警告一句 unknown component，页面上那一格**直接是空的**。
    # 真实发生过：AI 设置的开关（van-switch）没注册，
    # 设置页上「开关」根本不存在 —— 人只会觉得「没地方开」。
    ("用到的 van-* 组件都注册过（漏了就是一个空白的格子）",
     not (_van_used() - _van_registered())),

    # ── D39：AI 换一句也在训练页（发现坏句子那一刻就在改）──
    ("训练页能当场让 AI 换掉这句（不用退出去找）",
     "aiReplaceCurrent" in train
     and _re.search(r"让 AI 换掉这句例句", train) is not None
     and "replaceSentence as aiReplaceSentence" in train
     and _re.search(r"@applied=\"onAiApplied\"", train) is not None),

    # ── D40：整库体检 ──
    # 体检是二级页（不是 tab）：它是一次维护动作，不是一个地方。
    ("体检是二级页（从更多进、有返回、不占底栏）",
     _re.search(r"path: '/audit'[^}]*name: 'audit'", _ai_page("../main.ts")) is not None
     and _re.search(r"path: '/audit'[^}]*meta", _ai_page("../main.ts")) is None
     and "router.push('/audit')" in more),
    # 串行 + 逐词：并发会把「第几个词」变得没法交代，也更容易撞限流
    ("体检串行跑词、且只提议不自动应用",
     "await auditOne(" in _ai_page("AuditPage.vue")
     and "applyAll" not in _ai_src("audit.ts")
     and "applyOne" not in _ai_src("audit.ts")
     and "applyAll" not in _ai_page("AuditPage.vue")
     and _re.search(r"queueMicrotask\(", _ai_page("AuditPage.vue")) is not None),
    # 能停：这是花钱的动作，必须随时能叫停
    ("体检随时能停（停下不丢已跑的结果）",
     _re.search(r"function stop\(\)", _ai_page("AuditPage.vue")) is not None
     and "stopRequested" in _ai_page("AuditPage.vue")
     and "markAudited" in _ai_page("AuditPage.vue")),
    # 体检先跑「最像有问题」的：需精修 > 缺音标 > 例句少
    ("体检按「最可能需要修」排序（需精修 > 缺音标 > 例句少）",
     _re.search(r"if \(a\.refine !== b\.refine\) return b\.refine - a\.refine",
                _ai_src("audit.ts")) is not None
     and _re.search(r"a\.hasIpa \? 1 : -1", _ai_src("audit.ts")) is not None),

    # ── 提议类型：音标与熟词僻义 ──
    ("AI 能提出音标与熟词僻义，并且落库到正确的地方",
     _re.search(r"kind: 'word\.update'", _ai_src("parse.ts")) is not None
     and _re.search(r"patch\.trap = want", _ai_src("parse.ts")) is not None
     and _re.search(r"updateWord\(p\.word", _ai_src("apply.ts")) is not None
     and "patch.trap = p.trap" in _ai_src("apply.ts")),
    # 每种提议类型界面上都得有文案 —— 漏一种就是一条「看不太懂的空行」
    ("每种 AI 提议界面都有文案（漏一种就是一行看不懂的东西）",
     all(("'%s'" % k) in _src(os.path.join("components", "AiSheet.vue"))
         for k in ["sense.update", "word.update", "sentence.replace", "sentence.add", "sense.add"])),
    # 应用只发 applied，**不再补发 close**：调用方收到两次「这次结束了」，
    # 体检就会把队列推进两格（跳过一个词），日志里还多一条没有词名的记录。
    ("AI 浮层应用之后不再补发一次 close（否则体检会跳过一整词）",
     _re.search(r"appliedFired = true\s*\n\s*emit\('applied'",
                _src(os.path.join("components", "AiSheet.vue"))) is not None
     and "if (appliedFired)" in _src(os.path.join("components", "AiSheet.vue"))),
    # 一个词的回复坏了不该让整轮体检白跑；限流/余额/网络才停
    ("体检遇到坏回包只跳过这个词，不中断整轮",
     _re.search(r"kind === 'parse' \|\| e\.kind === 'refused'",
                _ai_page("AuditPage.vue")) is not None
     and _re.search(r"kind === 'parse'", _ai_src("audit.ts")) is not None),
    # 例句不全带：一个词四个义项二十句，光输入就两三千 token（D40 第五节）
    ("体检/审查的上下文按义项截断例句（省输入 token）",
     _re.search(r"const perSense = 2", _ai_src("actions.ts")) is not None
     and _re.search(r"omitted", _ai_src("types.ts")) is not None),
    # 音标：AI 只补缺，人得能自己改 —— 不然补错了/被改坏了就没有出口
    ("音标可以就地改（AI 只补缺，人要有出口）",
     _re.search(r"async function onIpaBlur", word) is not None
     and "updateWord(props.word, { ipa: next })" in word),

    # ── 体检的预算预览（以及「不做后台自动跑」的反向守卫）──
    # 「19 个词」在界面上看不出价格，而体检是花钱的动作。
    ("体检跑之前给预算预览（词数 / 已缓存 / 预计 token）",
     "auditEstimate(" in _ai_src("audit.ts")
     and "auditEstimate(" in _ai_page("AuditPage.vue")
     and _re.search(r"fmtTokens\(", _ai_page("AuditPage.vue")) is not None),
    # 预览说「全缓存过」而实际照样花钱，比没有预览更糟 —— 键必须是同一个函数算的
    ("预算预览与真正调用共用同一套缓存键",
     "export function cacheKeyOf" in _ai_src("actions.ts")
     and "cacheKeyOf('reviewWord'" in _ai_src("actions.ts")
     and "reviewSnapshot(" in _ai_src("audit.ts")),
    # 自动跑**刻意不做**：它背着用户花钱，而填的缓存只有人真的打开体检页才有价值。
    # 守卫反着写：一旦有人把「后台自动跑」加回来，这里就该红，逼一次显式决定。
    ("AI 不在后台偷偷跑（自动预跑已刻意移除）",
     "maybePrefetch" not in _ai_src("audit.ts")
     and "PREFETCH_DAY" not in _ai_src("audit.ts")
     and "autoDaily" not in _src(os.path.join("ai", "config.ts"))),

    # ── D41/D42：词库按学习进度组织、加词要一步到「能背」 ──
    # 词库页的五个桶就是「人心里想事情的顺序」；桶键必须和 quiz 的 scope 对得上
    ("词库按学习状态分桶（到期 / 在学 / 待学 / 已掌握 / 搁置）",
     all(("'%s'" % k) in lib for k in ["due", "learning", "new", "mastered", "idle"])
     and _re.search(r"function bucketOf\(", lib) is not None
     and _re.search(r"rank\[b\] < rank\[bucket\]", lib) is not None),
    # 桶能直接开练：词库从「台账」变「入口」
    ("每个桶都能直接开练（/train?scope=）",
     _re.search(r"router\.push\(\{ path: '/train', query: \{ scope \} \}\)", lib) is not None
     and "buildScopeQueue" in train
     and "buildScopeQueue" in _code(os.path.join(WEB, "src", "quiz.ts"))),
    # 仓库口径（需精修/缺例句/T1）降级成可折叠的「维护」视角
    ("内容维护口径降级为可折叠视角（不再是首屏主分类）",
     _re.search(r'class="maint"', lib) is not None
     and "maintain = ref(false)" in lib),
    # 加词：配了 AI 就一步到「能背的卡」，但仍然是「提议 → 人点应用」
    ("加词能一步生成义项与例句（AI 只提议、人点应用）",
     "fillWord(" in _src(os.path.join("components", "AddWordSheet.vue"))
     and re.search(r"@applied=\"onAiApplied\"",
                  _src(os.path.join("components", "AddWordSheet.vue"))) is not None
     and "AI 生成义项和例句" in _src(os.path.join("components", "AddWordSheet.vue"))),
    # 已有的词不再重复建：给「去这个词」而不是再建一张空壳
    ("已在库的词不重复建（给「去这个词」）",
     _re.search(r"const exists = ref\(false\)", _src(
         os.path.join("components", "AddWordSheet.vue"))) is not None
     and "去这个词" in _src(os.path.join("components", "AddWordSheet.vue"))),
    # updateWord 对不存在的词条不能是静默 no-op：AI 一批里「补音标 + 新建义项」时，
    # 音标那条会先跑（词条还没建），update 静默失败 → 音标丢失。
    ("updateWord 会建出词条（不靠 update 的静默 no-op）",
     _re.search(r"export async function updateWord[\s\S]{0,600}?db\.words\.put",
                _code(os.path.join(WEB, "src", "edit.ts"))) is not None),
    # 「排进明天练」是唯一一条「我说了算」的排期通道：
    # 只看 pinAt 不改 S/D/reps；排序上必须真的排到队首，否则等于没做。
    ("排进明天的卡排在队首，且不改学习记录",
     _re.search(r"pinned\.push\(s\.id\)", _code(os.path.join(WEB, "src", "quiz.ts"))) is not None
     and "const queue = [...pinned," in _code(os.path.join(WEB, "src", "quiz.ts"))
     and _re.search(r"db\.progress\.update\(senseId, \{ pinAt: at \}\)",
                    _code(os.path.join(WEB, "src", "edit.ts"))) is not None),
    # 「明天」的口径只能有一处（0 点），查词浮层与词库都读它
    ("「明天」的口径只有一处（tomorrowStart）",
     _re.search(r"export function tomorrowStart", _code(
         os.path.join(WEB, "src", "edit.ts"))) is not None
     and "tomorrowStart()" in _src(os.path.join("components", "WordPeek.vue"))),
    # 查词浮层要能「排进明天」，词库要能看见这个标记
    ("查词浮层能排进明天，词库看得见「明天练」",
     "排进明天练" in _src(os.path.join("components", "WordPeek.vue"))
     and _re.search(r'class="pin">明天练', lib) is not None),
]

fi = 0
for name, ok in interaction:
    print("  [%s] %s" % ("OK " if ok else "FAIL", name))
    if not ok:
        fi += 1

# ── 文档里的计数必须等于实际项数 ──
# 这些数字以前是手写的，于是必然过期：守卫从 77 项长到 110 项、
# 踩坑从 53 条长到 56 条，而四份文档还写着旧数字。文档写错的代价不是
# 「不好看」，而是**下次有人按它判断「一共就这么多坑」**，于是新坑没人找。
print("\n=== 文档里的计数必须等于实际项数 ===")
_notes_md = _read(os.path.join(PROJ, "docs", "notes", "踩坑记录.md"))
_manifest_md = _read(os.path.join(PROJ, "MANIFEST.md"))
_ai_md = _read(os.path.join(PROJ, "docs", "AI-操作手机闭环.md"))
_notes_readme = _read(os.path.join(PROJ, "docs", "notes", "README.md"))
_runbook = _read(os.path.join(PROJ, "app", "web", "DEBUG-RUNBOOK.md"))
_n_pitfalls = len(_documented_pitfalls())
counts = [
    ("MANIFEST 踩坑条数", _manifest_md, r"踩坑记录\.md\)（(\d+) 条）", _n_pitfalls),
    ("MANIFEST 真机守卫项数", _manifest_md, r"「真机交互守卫」里\s*（(\d+) 项）", len(interaction)),
    ("AI 闭环文档踩坑条数", _ai_md, r"(\d+) 条「不报错但结果不对」", _n_pitfalls),
    ("AI 闭环文档守卫项数", _ai_md, r"「真机交互守卫」(\d+) 项", len(interaction)),
    ("notes/README 守卫项数", _notes_readme, r"（当前 (\d+) 项）", len(interaction)),
    ("DEBUG-RUNBOOK 守卫项数", _runbook, r"「真机交互守卫」一节（(\d+) 项）", len(interaction)),
]
fc = 0
for _label, _txt, _pat, _actual in counts:
    _m = re.search(_pat, _txt)
    _claimed = int(_m.group(1)) if _m else None
    _ok = _claimed == _actual
    print("  [%s] %s：文档写 %s，实际 %d"
          % ("OK " if _ok else "FAIL", _label, _claimed, _actual))
    if not _ok:
        fc += 1

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

print("\n总计: D16 检查 %d 项失败 %d；真机交互守卫 %d 项失败 %d；文档计数 %d 项失败 %d"
      % (len(d16), f16, len(interaction), fi, len(counts), fc))
if fi:
    print("  ↑ 这些坑都不报错，只能靠断言拦住。解释见 docs/notes/踩坑记录.md")
sys.exit(1 if (f16 or fi or stale or fc) else 0)


