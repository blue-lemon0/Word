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
    ("三件套还在（错题板/手动掌握/训练 tab）",
     all(k in _train for k in ["markMastered", "再来一个", "这句有问题"])
     and "错题板" in _board
     and "label" not in _app and "训练" in _app),
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
        for ic in ["wap-home-o", "apps-o", "aim", "ellipsis"]) and "icon=\"apps-o\"" in _app),
    ("例句标记闭环还在（flagged + flagNote）",
     "flagNote" in _types and "flagSentence" in _src("edit.ts")),
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
     "导入内容包" in _src(os.path.join("pages", "LibraryPage.vue"))
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

    ★ 连**模板里的 HTML 注释**也一起去掉：`.vue` 的模板里满���是
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
    ("有「扫读」：报纸式多行例句，点哪句猜哪句",
     os.path.exists(os.path.join(WEB, "src", "pages", "ScanPage.vue"))
     and _re.search(r"export async function scanBatch", _code(
         os.path.join(WEB, "src", "quiz.ts"))) is not None
     and _re.search(r"sent:\s*String\(it\.sentence\.id\)",
                    _code(os.path.join(WEB, "src", "pages", "ScanPage.vue"))) is not None),
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
]

fi = 0
for name, ok in interaction:
    print("  [%s] %s" % ("OK " if ok else "FAIL", name))
    if not ok:
        fi += 1

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

print("\n总计: D16 检查 %d 项失败 %d；真机交互守卫 %d 项失败 %d"
      % (len(d16), f16, len(interaction), fi))
if fi:
    print("  ↑ 这些坑都不报错，只能靠断言拦住。解释见 docs/notes/踩坑记录.md")
sys.exit(1 if (f16 or fi or stale) else 0)
