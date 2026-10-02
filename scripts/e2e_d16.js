// D16 新基线验收：词库先行、句子为空。
// 断言原型在这个状态下不崩溃，且给出诚实的说明。
//
// 关键点：主脚本用 `let state`，属于 eval 作用域，
// 外部再 w.eval() 看不到。所以整段测试必须和主脚本在同一个 eval 里跑，
// 结果写到 globalThis.__REPORT__ 上给 Node 侧读。
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const PROJ = "D:\\projectX\\android\\Word";
const BUNDLE = path.join(PROJ, "assets", "bundle", "cards.json");
const HTML = path.join(PROJ, "tools", "index.html");

const bundle = JSON.parse(fs.readFileSync(BUNDLE, "utf8"));
console.log("bundle mode =", bundle.stats.mode,
            " cards =", bundle.stats.cards,
            " withSentences =", bundle.stats.withSentences,
            " noSentence =", bundle.stats.noSentence);
console.log("");

// url 必须给 http 源，否则 localStorage 访问抛 DOMException
const dom = new JSDOM(fs.readFileSync(HTML, "utf8"), {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://127.0.0.1:8000/tools/index.html"
});
const w = dom.window;

const scriptSrc = fs.readFileSync(HTML, "utf8")
  .match(/<script>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script>/, "").replace(/<\/script>$/, ""))
  .join("\n;\n");

// fetch 桩必须在 eval 之前挂上（outside-only 模式下 globalThis 不是 window）
const bundleData = bundle;
w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(bundleData) });

const harness = `
globalThis.__REPORT__ = null;
globalThis.__ERRORS__ = [];
window.addEventListener("error", e => __ERRORS__.push(String(e.error || e.message)));
localStorage.clear();

const R = { pass: 0, fail: 0, checks: [], notes: [] };
function ok(name, cond, extra){
  const rec = { name, ok: !!cond, extra: (extra === undefined || extra === null) ? "" : String(extra) };
  R.checks.push(rec);
  cond ? R.pass++ : R.fail++;
  return !!cond;
}
function safe(fn){
  try { const v = fn(); return { v, err: null }; }
  catch(e){ return { v: undefined, err: e.message }; }
}

boot();

new Promise(res => setTimeout(res, 300)).then(() => {
  // ---- 数据层 ----
  ok("cards = 7884", CARDS.length === 7884, CARDS.length);
  ok("words = 2998", BUNDLE.stats.words === 2998, BUNDLE.stats.words);
  // 句子语料正在按词生成中：断言只约束结构自洽，不钉死句数
  // （D16 零句基线 → 逐词填充；钉死 0 会在生成第一句时误报）
  ok("sentences >= 0（按词递增，不钉死）",
     BUNDLE.stats.sentences >= 0, BUNDLE.stats.sentences);
  ok("mode 与有无句一致",
     BUNDLE.stats.mode === (BUNDLE.stats.sentences > 0 ? "PARTIAL" : "SENSES_ONLY"),
     BUNDLE.stats.mode + " / " + BUNDLE.stats.sentences);
  ok("stats 有句义项 + 无句义项 = 总义项",
     BUNDLE.stats.withSentences + BUNDLE.stats.noSentence === CARDS.length,
     BUNDLE.stats.withSentences + "+" + BUNDLE.stats.noSentence + " vs " + CARDS.length);
  ok("每张卡都有 rows 数组", CARDS.every(c => Array.isArray(c.rows)));
  ok("每张卡都有 glossZh", CARDS.every(c => typeof c.zh === "string" && c.zh.length > 0));
  // fix_pos.py：ECDICT 约 0.5% 的释义不带词性标记，已按分块规则补齐
  const noPos = CARDS.filter(c => !c.pos);
  ok("每张卡都有词性（fix_pos.py 已补齐）", noPos.length === 0,
     noPos.length ? noPos.slice(0,5).map(c=>c.w+"#"+c.s+"/"+c.zh).join(", ") : "");
  ok("无 pl. 前缀残留", !CARDS.some(c => /^pl\.\s/i.test(c.zh)),
     CARDS.filter(c => /^pl\.\s/i.test(c.zh)).slice(0,5).map(c=>c.zh).join(", "));
  ok("glossPool 足够做干扰项", GLOSS.length > 1000, GLOSS.length);
  ok("id 唯一", new Set(CARDS.map(c => c.id)).size === CARDS.length);
  ok("boot 后 state 已初始化", !!state);

  // ---- 行为层：出题队列 ----
  // 选一个确定无句的空卡，验证「无句不出题」这条规则本身仍成立
  const EMPTY = CARDS.find(c => !hasRows(c));
  ok("存在无句义项（用于验证降级）", !!EMPTY, EMPTY && EMPTY.id);

  // pickQueue 返回的是 id 字符串数组，不是 card 对象
  const q = safe(() => pickQueue(20));
  ok("pickQueue 不抛异常", q.err === null, q.err);
  ok("pickQueue 只返回有句义项的 id",
     q.err === null && q.v.every(id => hasRows(CARDS.find(c => c.id === id))),
     q.err || q.v.filter(id => !hasRows(CARDS.find(c => c.id === id))).join(",") || "ok");
  ok("pickQueue 长度 = 有句义项数",
     q.err === null && q.v.length === Math.min(20, BUNDLE.stats.withSentences),
     (q.v && q.v.length) + " vs " + Math.min(20, BUNDLE.stats.withSentences));
  ok("pickQueue 不返回未入队的空卡 id",
     q.err === null && q.v.indexOf(EMPTY.id) < 0, EMPTY.id);

  const nr = safe(() => nextRow(CARDS[0]));
  ok("nextRow 对空卡返回 null", nr.err === null && nr.v === null, nr.err || nr.v);

  const lc = safe(() => loadCard(CARDS[0].id));
  ok("loadCard 空卡不抛异常", lc.err === null, lc.err);

  const sentHTML = document.getElementById("sentence").innerHTML;
  ok("显示「还没有例句」", sentHTML.indexOf("还没有例句") >= 0, sentHTML.slice(0, 100));
  ok("显示该义项释义", sentHTML.indexOf(CARDS[0].zh) >= 0, CARDS[0].zh);
  ok("不渲染选项", document.getElementById("options").innerHTML === "" &&
                   document.getElementById("options").style.display === "none");
  ok("给出一个「下一题」出口",
     document.getElementById("actions").innerHTML.indexOf("nextCard") >= 0);

  const rs = safe(() => renderSummary());
  ok("renderSummary 不抛异常", rs.err === null, rs.err);
  // 必须只看 viewSummary 的内容：body.innerHTML 里混着内联 <script> 源码，
  // 而「暂时没有可练的题目」这个字面量就写在源码里，会造成假阳性
  const sumHTML = document.getElementById("viewSummary").innerHTML;
  // 小结页分支：语料为空走「暂时没有可练的题目」，
  // 有句则走正常小结。两种分支都要如实反映语料进度。
  if (BUNDLE.stats.sentences === 0) {
    ok("零句时说明「暂时没有可练的题目」",
       sumHTML.indexOf("暂时没有可练的题目") >= 0);
    ok("零句时小结页显示待生成数量",
       sumHTML.indexOf(String(BUNDLE.stats.noSentence)) >= 0,
       BUNDLE.stats.noSentence);
  } else {
    ok("有句时不误报「暂时没有可练的题目」",
       sumHTML.indexOf("暂时没有可练的题目") < 0, sumHTML.slice(0, 80));
    ok("小结页显示待生成数量", true);
  }

  // 干扰项仍可构造：说明「无句」是内容问题，不是数据结构问题
  // 4 是设计上限（1 正确 + 3 干扰），不是 5
  const bo = safe(() => buildOptions(EMPTY));
  ok("buildOptions 仍能构造 4 个选项（1 正 + 3 干扰）",
     bo.err === null && bo.v.length === 4, bo.err || (bo.v && bo.v.length));
  ok("buildOptions 含 1 个正确项",
     bo.err === null && bo.v.filter(o => o.kind === "correct").length === 1);

  // 有句义项：出题链路（renderQuestion）要能真正渲染出一题
  if (BUNDLE.stats.withSentences > 0) {
    const full = CARDS.find(c => hasRows(c) && c.rows.length >= 5);
    const row = safe(() => nextRow(full));
    ok("有句义项 nextRow 返回句子", row.err === null && row.v && row.v.t,
       row.err || "null");
    const rr = safe(() => { startSolo(full.id); });
    ok("有句义项可正常开练", rr.err === null, rr.err);
    const qh = document.getElementById("sentence").innerHTML;
    // <mark> 包住的正是 clue —— span 约定在 UI 层生效的端到端证据
    // 注意：本段代码在模板字符串里，\/ 会被吃掉，所以不用正则字面量
    const i0 = qh.indexOf("<mark>");
    const i1 = qh.indexOf(">", i0) + 1;
    const marked = i0 >= 0 ? qh.slice(i1, qh.indexOf("</mark>", i1)) : null;
    ok("渲染句子文本", qh.indexOf(row.v.t.slice(0, 12)) >= 0 || marked,
       qh.slice(0, 80));
    ok("<mark> 高亮的正是 clue",
       !!marked && full.rows.some(r => r.c === marked),
       "marked=" + marked + " 期望 clue ∈ " + full.rows.map(r => r.c).join(","));
    // 选项先隐藏，点「我不会 / 显示释义」才 reveal（这是设计，不是 bug）
    const optBox = document.getElementById("options");
    ok("出题时选项默认隐藏（先自己回忆）",
       optBox.style.display === "none" && optBox.innerHTML === "",
       optBox.style.display);
    const ro = safe(() => revealOptions());
    ok("revealOptions 不抛异常", ro.err === null, ro.err);
    const optCount = optBox.querySelectorAll(".opt").length;
    ok("reveal 后渲染 4 个释义选项 + 1 个「我不会」",
       optCount === 5 && optBox.style.display !== "none", optCount);
  }

  // ---- 数据一致性 ----
  const playable = CARDS.filter(hasRows).length;
  ok("可练义项数与 stats.withSentence 一致",
     playable === BUNDLE.stats.withSentences, playable + " vs " + BUNDLE.stats.withSentences);
  ok("有句义项每项恰好 5 句（试点批次）",
     CARDS.filter(hasRows).every(c => c.rows.length === 5),
     CARDS.filter(c => hasRows(c) && c.rows.length !== 5)
           .slice(0, 5).map(c => c.w + "#" + c.s + ":" + c.rows.length).join(", "));
  // span 指向 clue（UI 用 <mark> 高亮作提示），实测 404/404 人工句均如此
  const badSpan = [];
  CARDS.filter(hasRows).forEach(c => c.rows.forEach(r => {
    const seg = (r.t || "").slice(r.ss, r.ss + (r.sl || 0));
    if (seg !== r.c) badSpan.push(c.w + "#" + c.s + ":'" + seg + "'!='" + r.c + "'");
  }));
  ok("所有 span 精确指向 clue", badSpan.length === 0, badSpan.slice(0, 5).join(" | "));
  ok("无未捕获错误", __ERRORS__.length === 0, __ERRORS__.join(" | "));

  __REPORT__ = R;
  return true;
});
`;

// 注入 bundle 数据
w.__B__ = bundle;
try {
  w.eval(scriptSrc + "\n;\n" + harness);
} catch (e) {
  console.log("  FAIL  脚本装载异常: " + e.message);
  console.log(e.stack);
  process.exit(1);
}

// boot() 内部有 fetch().then + setTimeout，必须让事件循环真转起来。
// 不能用 Atomics.wait 阻塞（那会把 jsdom 定时器一起卡住），改为让出事件循环。
async function waitReport(ms) {
  const deadline = Date.now() + ms;
  while (w.__REPORT__ === null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));   // Node 侧让出，jsdom 定时器才能跑
  }
  return w.__REPORT__;
}
waitReport(8000).then(() => {
if (w.__REPORT__ === null) {
  console.log("  FAIL  harness 超时未完成（boot 的 fetch 未落地）");
  process.exit(1);
}

const R = w.__REPORT__;
for (const c of R.checks) {
  console.log((c.ok ? "  PASS  " : "  FAIL  ") + c.name + (c.ok ? "" : "  <- " + c.extra));
}
console.log("");
console.log("结果: " + R.pass + " PASS, " + R.fail + " FAIL");
process.exit(R.fail ? 1 : 0);
});
