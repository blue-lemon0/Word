// 最小学习循环的端到端验收。
//   node scripts/e2e_loop.mjs
//
// 覆盖：进度持久化、到期判定、幂等、事务原子性、SRS 数值（与 verify_srs.py 对齐）。
// 用临时 db，不碰 data/user.db。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from '../app/db.mjs';
import { loadParams, easeFactor, classify, applyReview, fastThresholdMs } from '../app/srs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..');
const TMP = path.join(os.tmpdir(), 'word-e2e-' + Date.now());

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
}
function near(a, b, eps = 0.02) { return Math.abs(a - b) <= eps; }
function group(t) { console.log(`\n=== ${t} ===`); }

const P = loadParams();
const bundle = store.loadBundle();
const dbFile = path.join(TMP, 'user.db');
let db = store.openDb(dbFile);

// ─────────────────────────────────────────────────────────
group('建库与 bundle 投影');
const nCards = store.syncBundle(db, bundle);
ok(nCards === bundle.cards.length, `card 投影 ${nCards} = bundle 义项数`);
ok(db.prepare('SELECT COUNT(*) n FROM card').get().n === bundle.cards.length,
   'card 表行数与 bundle 一致');
ok(store.syncBundle(db, bundle) === 0, 'bundle 未变时跳过重建');
const withSent = bundle.cards.filter((c) => c.rows.length).length;
ok(db.prepare('SELECT COUNT(*) n FROM v_pool').get().n === withSent,
   `v_pool = ${withSent}（只有有句义项可练）`);
ok(db.prepare('SELECT COUNT(*) n FROM v_due').get().n === withSent,
   '全部未练过 → 全部到期');
ok(db.prepare('SELECT COUNT(*) n FROM card_state').get().n === 0,
   '未练过的卡不预插空状态行');

const lay = bundle.cards.find((c) => c.w === 'lay' && c.s === 's1');
ok(lay != null, 'bundle 里有 lay#s1');

// ─────────────────────────────────────────────────────────
group('SRS 数值：与 verify_srs.py 的推演表逐格比对');
// 03 §4.1.1：主义 s1 (S0=2.0,D0=5.0) 连对 4 次 → 2.0 / 4.1 / 8.3 / 16.8
// 同日重复会触发 SAME_DAY_FACTOR，所以每次推进 1 天（>6h）
{
  // 这四个向量就是 verify_srs.py 连对 4 次表的逐格取值，两边必须完全一致
  const golden = [
    ['主义 s1', 2.0, 5.0, [2.04, 4.12, 8.32, 16.81]],
    ['TRAP', 0.8, 7.0, [0.62, 1.11, 1.98, 3.52]],
    ['单义', 1.2, 6.0, [1.08, 2.05, 3.90, 7.41]],
    ['新词', 0.6, 8.0, [0.40, 0.66, 1.09, 1.81]],
  ];
  let S, D, allOk = true, detail = '';
  for (const [name, S0, D0, expect] of golden) {
    S = S0; D = D0;
    const got = [];
    for (let i = 0; i < 4; i++) {
      const iv = S * easeFactor(P, D);
      got.push(iv);
      S *= (1 + easeFactor(P, D));
    }
    for (let i = 0; i < 4; i++) {
      if (!near(got[i], expect[i], 0.02)) {
        allOk = false;
        detail += `${name} 第${i + 1}次 ${got[i].toFixed(2)}≠${expect[i]} `;
      }
    }
  }
  ok(allOk, '连对 4 次的间隔演化与 verify_srs.py 一致', detail);
  ok(near(easeFactor(P, 1), 1.50, 0.001) && near(easeFactor(P, 10), 0.42, 0.001),
     'ease_factor 端点 D=1→1.50, D=10→0.42');
  let mono = true;
  for (let d = 1; d <= 9; d++) if (!(easeFactor(P, d) > easeFactor(P, d + 1))) mono = false;
  ok(mono, 'ease_factor 单调递减');
}

group('义项类型判据（03 §3）');
{
  const cases = [
    [{ is_trap: 1, tier: 'T1', n_senses: 4, sense_id: 's1' }, 'TRAP', 0.8, 7.0],
    [{ is_trap: 0, tier: 'T3', n_senses: 2, sense_id: 's1' }, 'RARE', 0.5, 8.5],
    [{ is_trap: 0, tier: 'T1', n_senses: 4, sense_id: 's1' }, 'MULTI_S1', 2.0, 5.0],
    [{ is_trap: 0, tier: 'T1', n_senses: 1, sense_id: 's1' }, 'SINGLE', 1.2, 6.0],
    [{ is_trap: 0, tier: 'T1', n_senses: 4, sense_id: 's2' }, 'NEW', 0.6, 8.0],
  ];
  for (const [card, kind, S0, D0] of cases) {
    const c = classify(P, card);
    ok(c.kind === kind && near(c.S0, S0, 1e-9) && near(c.D0, D0, 1e-9),
       `${JSON.stringify(card).slice(0, 46)} → ${kind} S0=${S0} D0=${D0}`,
       `实得 ${c.kind} S0=${c.S0} D0=${c.D0}`);
  }
}

// ─────────────────────────────────────────────────────────
group('难度漂移方向（03 §4.2 的公式符号与注解相反，按注解实现）');
{
  const card = { tier: 'T1', is_trap: 0, n_senses: 4, sense_id: 's1' };
  const base = { stability: 2, difficulty: 5, reps: 3, wrong_n: 0, pending_n: 0, mastered: 0, rusty: 0, last_review: null };
  const t = Math.floor(Date.now() / 1000);
  const fast = applyReview(P, base, card, 'CORRECT', 3000, t);
  const slow = applyReview(P, base, card, 'CORRECT', 99000, t);
  const wrong = applyReview(P, base, card, 'WRONG', 9000, t);
  const pend = applyReview(P, base, card, 'PENDING', null, t);
  ok(fast.difficulty < base.difficulty, `答得快 D 下降 ${base.difficulty} → ${fast.difficulty.toFixed(2)}`);
  ok(Math.abs(slow.difficulty - base.difficulty) < 1e-9, '答得慢 D 不变（不奖不惩）');
  ok(pend.difficulty > base.difficulty, `不会 D 上升 → ${pend.difficulty.toFixed(2)}`);
  ok(wrong.difficulty > pend.difficulty, `答错 D 升得比不会更多 → ${wrong.difficulty.toFixed(2)}`);
  ok(fast.intervalDays > slow.intervalDays, '同一个 S 下答得快间隔更长');
  ok(fast.grade === P.GRADE_FAST && slow.grade === P.GRADE_SLOW,
     `快/慢分档 ${fast.grade} / ${slow.grade}（基准 ${fastThresholdMs(P, 5)}ms）`);
}

group('一次完整作答 → 进度落库');
const DAY = 86400;
// 时间线起点放在过去 200 天：v_due 用真实 strftime('%s','now') 判定到期，
// 如果把作答时间戳写成未来时间，卡片永远不会到期，测试会假绿。
const t0 = Math.floor(Date.now() / 1000) - 200 * DAY;
const r1 = store.commitAnswer(db, P, bundle, {
  sessionId: 'e2e', idx: 0, word: 'lay', senseId: 's1',
  result: 'CORRECT', elapsedMs: 3000, ts: t0,
});
ok(r1.applied, '首次提交生效');
ok(near(r1.stability, 2.0 * (1 + easeFactor(P, 5)), 0.01),
   `S 从 S0 增长到 ${r1.stability.toFixed(2)}`);
ok(near(r1.intervalDays, 2.0 * easeFactor(P, 5), 0.01),
   `首次间隔 = S0 × ef = ${r1.intervalDays.toFixed(2)} 天`);
ok(r1.dueAt === t0 + Math.round(r1.intervalDays * DAY), '到期时间戳 = ts + 间隔');
{
  const row = db.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1');
  ok(row.due_at === r1.dueAt,
     'due_at 落库且与引擎返回值一致（视图必须读这一列，不能现算 last_review+S）');
  ok(row.due_at < row.last_review + row.stability * DAY,
     'due_at 早于 last_review+stability：排期用的是答对前的 S，现算会晚将近一倍');
}
ok(db.prepare('SELECT COUNT(*) n FROM review_log').get().n === 1, '流水写了 1 行');
ok(db.prepare('SELECT reps FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1').reps === 1,
   'reps = 1');
ok(db.prepare('SELECT COUNT(*) n FROM v_due').get().n === withSent,
   't0 在 200 天前，这批卡早已重新到期（时间线是过去的）');

group('刚答完立刻不再到期（用真实时钟）');
{
  const ndb = store.openDb(path.join(TMP, 'now.db'));
  store.syncBundle(ndb, bundle);
  const t = Math.floor(Date.now() / 1000);
  ok(ndb.prepare('SELECT COUNT(*) n FROM v_due').get().n === withSent, '开练前全部到期');
  const first = store.commitAnswer(ndb, P, bundle, {
    sessionId: 'now', idx: 0, attemptId: 'now#1', word: 'lay', senseId: 's1',
    result: 'CORRECT', elapsedMs: 3000, ts: t,
  });
  ok(ndb.prepare('SELECT COUNT(*) n FROM v_due WHERE word=? AND sense_id=?').get('lay', 's1').n === 0,
     '刚答过的卡不在到期池');
  ok(ndb.prepare('SELECT COUNT(*) n FROM v_due').get().n === withSent - 1, '到期数少 1');
  // 把时钟往前拨一个真实间隔：到期满后必须重新到期
  ndb.prepare('UPDATE card_state SET due_at = due_at - ? WHERE word=? AND sense_id=?')
     .run(Math.ceil(first.intervalDays * DAY) + 60, 'lay', 's1');
  ok(ndb.prepare('SELECT COUNT(*) n FROM v_due WHERE word=? AND sense_id=?').get('lay', 's1').n === 1,
     `过了 ${first.intervalDays.toFixed(2)} 天的间隔后重新到期`);
  ndb.close();
}

group('幂等：同一次出题的重复提交');
{
  const a0 = { sessionId: 'e2e', idx: 0, attemptId: 'e2e#1', word: 'lay', senseId: 's1' };
  const again = store.commitAnswer(db, P, bundle, {
    ...a0, result: 'CORRECT', elapsedMs: 3000, ts: t0 + 60,
  });
  ok(again.applied === false, '同 attempt 重发 applied=false');
  const st = db.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1');
  ok(st.reps === 1, `reps 仍是 1（实际 ${st.reps}）`);
  ok(near(st.stability, r1.stability, 1e-9), 'S 没有被二次累加');
  ok(db.prepare('SELECT COUNT(*) n FROM review_log').get().n === 1, '流水仍然 1 行');

  // 换一个 attempt 但还是同一张卡 —— 这是「同一场里合法地再见一次」，
  // 必须被接受（03 §4.1 的 WRONG 后 2 小时再现就落在同一场）。
  const again2 = store.commitAnswer(db, P, bundle, {
    sessionId: 'e2e', idx: 1, attemptId: 'e2e#2', word: 'lay', senseId: 's1',
    result: 'CORRECT', elapsedMs: 3000, ts: t0 + 90,
  });
  ok(again2.applied === true, '同卡换 attempt 被接受（同场重复出现合法）');
  ok(db.prepare('SELECT COUNT(*) n FROM review_log').get().n === 2, '流水 2 行');
}

group('答错与不会');
{
  const wrong = store.commitAnswer(db, P, bundle, {
    sessionId: 's-wrong', idx: 1, attemptId: 's-wrong#1', word: 'lay', senseId: 's1',
    result: 'WRONG', elapsedMs: 9000, ts: t0 + 2 * DAY,
  });
  ok(wrong.stability < r1.stability, `WRONG 让 S 下降 ${r1.stability.toFixed(2)}→${wrong.stability.toFixed(2)}`);
  ok(wrong.difficulty > r1.difficulty, `WRONG 让 D 上升 ${r1.difficulty.toFixed(1)}→${wrong.difficulty.toFixed(1)}`);
  ok(near(wrong.intervalDays, Math.max(P.INTERVAL_FLOOR, wrong.stability / P.S_WRONG * P.S_WRONG), 0.3)
     || wrong.intervalDays >= P.INTERVAL_FLOOR, `间隔不低于下界 ${P.INTERVAL_FLOOR} 天（实得 ${wrong.intervalDays.toFixed(2)}）`);
  ok(db.prepare('SELECT wrong_n FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1').wrong_n === 1,
     'wrong_n = 1');
  ok(db.prepare('SELECT COUNT(*) n FROM v_wrong WHERE word=? AND sense_id=?').get('lay', 's1').n === 1,
     '进了错题板');

  const pend = store.commitAnswer(db, P, bundle, {
    sessionId: 's-wrong', idx: 2, attemptId: 's-wrong#2', word: 'lay', senseId: 's1',
    result: 'PENDING', elapsedMs: null, ts: t0 + 4 * DAY,
  });
  ok(pend.grade === P.GRADE_PEND, 'PENDING 的 grade = 2');
  const st = db.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1');
  ok(st.pending_n === 1, 'pending_n = 1');
  ok(st.mastered === 0, '有 PENDING 就不能算掌握');
  ok(db.prepare('SELECT COUNT(*) n FROM v_wrong WHERE word=? AND sense_id=?').get('lay', 's1').n === 1,
     '「不会」后仍留在错题板（最近第 2 次不是 CORRECT）');
}

group('错题板移出条件：连续 2 次答对');
{
  store.commitAnswer(db, P, bundle, {
    sessionId: 's-board', idx: 0, attemptId: 's-board#1', word: 'lay', senseId: 's1', result: 'CORRECT',
    elapsedMs: 3000, ts: t0 + 6 * DAY,
  });
  ok(db.prepare('SELECT COUNT(*) n FROM v_wrong WHERE word=? AND sense_id=?').get('lay', 's1').n === 1,
     '只对了 1 次还没移出');
  store.commitAnswer(db, P, bundle, {
    sessionId: 's-board', idx: 1, attemptId: 's-board#2', word: 'lay', senseId: 's1', result: 'CORRECT',
    elapsedMs: 3000, ts: t0 + 8 * DAY,
  });
  ok(db.prepare('SELECT COUNT(*) n FROM v_wrong WHERE word=? AND sense_id=?').get('lay', 's1').n === 0,
     '连对 2 次后移出错题板');
}

group('同日重复：增长减半');
{
  const a = store.commitAnswer(db, P, bundle, {
    sessionId: 's-same', idx: 0, attemptId: 's-same#1', word: 'lay', senseId: 's2', result: 'CORRECT',
    elapsedMs: 3000, ts: t0,
  });
  const b = store.commitAnswer(db, P, bundle, {
    sessionId: 's-same', idx: 1, attemptId: 's-same#2', word: 'lay', senseId: 's2', result: 'CORRECT',
    elapsedMs: 3000, ts: t0 + 3600,
  });
  const fresh = store.commitAnswer(db, P, bundle, {
    sessionId: 's-same2', idx: 0, attemptId: 's-same2#1', word: 'lay', senseId: 's3', result: 'CORRECT',
    elapsedMs: 3000, ts: t0,
  });
  ok(!a.sameDay && b.sameDay, '间隔 6 小时内标 sameDay');
  const expectB = a.stability * (1 + easeFactor(P, a.difficulty) * P.SAME_DAY_FACTOR);
  const noDiscount = a.stability * (1 + easeFactor(P, a.difficulty));
  ok(b.stability < noDiscount && near(b.stability, expectB, 0.01),
     `同日第二次 S 增长打折 ${a.stability.toFixed(2)} → ${b.stability.toFixed(2)}` +
     `（不打折会是 ${noDiscount.toFixed(2)}）`);
  ok(fresh.kind === 'NEW', `lay#s3 判为 NEW（S0=${P.S0_NEW}）`);
}

group('掌握门槛：90 天 + 6 次 + 连对 3');
{
  // 独立 db：这一组要模拟几个月的复习史，不能污染上面那批卡的状态
  const mdb = store.openDb(path.join(TMP, 'master.db'));
  store.syncBundle(mdb, bundle);
  let t = Math.floor(Date.now() / 1000) - 300 * DAY;
  for (let i = 0; i < 14; i++) {
    const last = store.commitAnswer(mdb, P, bundle, {
      sessionId: 'master', idx: i, attemptId: 'master#' + i, word: 'lay', senseId: 's4', result: 'CORRECT',
      elapsedMs: 3000, ts: t,
    });
    t += Math.max(1, Math.ceil(last.intervalDays)) * DAY;
    if (mdb.prepare('SELECT mastered FROM card_state WHERE word=? AND sense_id=?')
         .get('lay', 's4').mastered) break;
  }
  const st = mdb.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's4');
  ok(st.mastered === 1, `连对后达成掌握（S=${st.stability.toFixed(0)}天 reps=${st.reps}）`);
  ok(st.stability >= P.MASTER_S && st.reps >= P.MASTER_REPS,
     `同时满足 S>=${P.MASTER_S} 与 reps>=${P.MASTER_REPS}`);
  ok(st.pending_n === 0 && mdb.prepare(
       'SELECT COUNT(*) n FROM v_wrong WHERE word=? AND sense_id=?').get('lay', 's4').n === 0,
     '全程无 PENDING、不在错题板');
  ok(mdb.prepare('SELECT COUNT(*) n FROM v_due WHERE word=? AND sense_id=?').get('lay', 's4').n === 0,
     '已掌握不再进到期池');

  // 掌握后答错：掌握标记必须撤回，否则这张卡被永久移出复习计划
  const wrongT = Math.floor(Date.now() / 1000) - 10 * DAY;
  store.commitAnswer(mdb, P, bundle, {
    sessionId: 'master', idx: 99, attemptId: 'master#99', word: 'lay', senseId: 's4', result: 'WRONG',
    elapsedMs: 9000, ts: wrongT,
  });
  const after = mdb.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's4');
  ok(after.mastered === 0, '掌握后答错 → 掌握标记被撤回');
  ok(mdb.prepare('SELECT COUNT(*) n FROM v_due WHERE word=? AND sense_id=?').get('lay', 's4').n === 0,
     '刚答错的当下还没到期（S 仍很大）');

  // 时间流逝 200 天 → 重新进入排布
  mdb.prepare('UPDATE card_state SET due_at = due_at - ? WHERE word=? AND sense_id=?')
     .run(200 * DAY, 'lay', 's4');
  ok(mdb.prepare('SELECT COUNT(*) n FROM v_due WHERE word=? AND sense_id=?').get('lay', 's4').n === 1,
     '再过 200 天后重新到期');
  mdb.close();
}

group('长期不练的衰减是惰性的');
{
  const db2File = path.join(TMP, 'idle.db');
  const db2 = store.openDb(db2File);
  store.syncBundle(db2, bundle);
  const t = Math.floor(Date.now() / 1000);
  const r = store.commitAnswer(db2, P, bundle, {
    sessionId: 'idle', idx: 0, attemptId: 'idle#1', word: 'lay', senseId: 's1', result: 'CORRECT',
    elapsedMs: 3000, ts: t,
  });
  const raw = db2.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1');
  const decayed = (await import('../app/srs.mjs')).decayIfIdle(P, raw, t + 200 * DAY);
  ok(raw.stability === r.stability, '读取不写库：原值未被改动');
  ok(decayed.stability < raw.stability && decayed.rusty === 1,
     `只读时算出衰减 ${raw.stability.toFixed(2)}→${decayed.stability.toFixed(2)} 并标 rusty`);
  db2.close();
}

group('持久化：关掉重开');
{
  const before = db.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1');
  const logN = db.prepare('SELECT COUNT(*) n FROM review_log').get().n;
  db.close();
  db = store.openDb(dbFile);
  const after = db.prepare('SELECT * FROM card_state WHERE word=? AND sense_id=?').get('lay', 's1');
  ok(after.stability === before.stability && after.reps === before.reps &&
     after.wrong_n === before.wrong_n,
     'card_state 逐字段一致');
  ok(db.prepare('SELECT COUNT(*) n FROM review_log').get().n === logN,
     `review_log 仍是 ${logN} 行`);
  ok(store.syncBundle(db, bundle) === 0, '重开后不重复投影 bundle');
}

group('事务原子性：非法输入不留半截写入');
{
  const logN = db.prepare('SELECT COUNT(*) n FROM review_log').get().n;
  let threw = false;
  try {
    store.commitAnswer(db, P, bundle, {
      sessionId: 'e2e', idx: 7, word: 'lay', senseId: 's99', result: 'CORRECT', elapsedMs: 1000,
    });
  } catch { threw = true; }
  ok(threw, '不存在的义项抛错');
  ok(db.prepare('SELECT COUNT(*) n FROM review_log').get().n === logN, '流水没有多出半行');
  ok(db.prepare('SELECT COUNT(*) n FROM card_state WHERE word=? AND sense_id=?')
     .get('lay', 's99').n === 0, '没有留下孤儿状态行');
}

group('诚实正确率只算到期卡次');
{
  const row = db.prepare('SELECT * FROM v_accuracy').all();
  const total = row.reduce((a, r) => a + r.n, 0);
  const dueOnly = db.prepare(
    'SELECT COUNT(*) n FROM review_log WHERE is_due=1 AND result IN (\'CORRECT\',\'WRONG\',\'PENDING\')')
    .get().n;
  ok(total === dueOnly, `v_accuracy 只覆盖 is_due=1 的作答（${total} = ${dueOnly}）`);
}

group('概览与排布');
{
const ov = store.overview(db, P);
  ok(ov.pool === withSent, `可练 ${ov.pool}`);
  ok(ov.answered > 0, `累计作答 ${ov.answered}`);
  ok(ov.mastered === db.prepare('SELECT COUNT(*) n FROM card_state WHERE mastered=1').get().n,
     `概览的已掌握数与 card_state 一致（${ov.mastered}）`);
  ok(ov.wrong === db.prepare('SELECT COUNT(*) n FROM v_wrong').get().n,
     `概览的错题数与 v_wrong 一致（${ov.wrong}）`);
  const q = store.layout(db, P, 5);
  ok(q.length > 0 && q.length <= 5, `排布返回 ${q.length} 张`);
  ok(q.every((r) => store.pickSentence(bundle, r.word, r.sense_id, 0)),
     '排布出的每张卡都真的能取到句子');
  const w = q.map((r) => 0.5 * r.wrong_n + 0.3 * r.is_trap +
                     0.2 * (1 - Math.max(0, Math.min(1, 1 - r.stability / 180))));
  ok(w.every((v, i) => i === 0 || w[i - 1] >= v - 1e-9),
     '按权重降序（03 §5.2 的 clamp 要一起复刻，否则 S>180 时排序会不一致）');
}

group('用户 db 不会随 bundle 重置');
{
  const n1 = db.prepare('SELECT COUNT(*) n FROM card_state').get().n;
  store.rebuildCards(db, bundle);
  const n2 = db.prepare('SELECT COUNT(*) n FROM card_state').get().n;
  ok(n1 === n2, `重建 card 投影后进度行数不变（${n1}）`);
}

db.close();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);