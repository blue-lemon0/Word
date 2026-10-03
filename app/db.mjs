// user.db 的读写层。Node 侧用内置 node:sqlite（SQLite 3.51），Android 侧用原生
// SQLite —— schema.sql 是两边唯一的真相源，本文件只是把它包成可调用的接口。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadParams, applyReview, decayIfIdle, isMastered, weight } from './srs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJ = path.resolve(HERE, '..');
export const SCHEMA_SQL = path.join(HERE, 'schema.sql');
export const BUNDLE = path.join(PROJ, 'assets', 'bundle', 'cards.json');
export const USER_DB = path.join(PROJ, 'data', 'user.db');
const SCHEMA_VERSION = '1';

export function loadBundle(file = BUNDLE) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `缺少 bundle: ${file}\n先跑  python scripts/build_bundle.py`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function openDb(userPath = USER_DB) {
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  const db = new DatabaseSync(userPath);
  db.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
  const cur = getMeta(db, 'schema_version');
  if (cur == null) setMeta(db, 'schema_version', SCHEMA_VERSION);
  else if (cur !== SCHEMA_VERSION) {
    throw new Error(
      `user.db schema 版本 ${cur} ≠ 代码期望 ${SCHEMA_VERSION}。\n` +
      `个人工具不做降级迁移：备份 data/user.db 后删掉重建。`);
  }
  return db;
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ' +
             'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/**
 * 把 bundle 投影进 card 表。整表重建 —— card 里没有任何真相，
 * 每次 bundle 变化都该完全重来，所以不用费劲做差异比对。
 */
export function rebuildCards(db, bundle) {
  const nSensesByWord = new Map();
  for (const c of bundle.cards) {
    nSensesByWord.set(c.w, (nSensesByWord.get(c.w) || 0) + 1);
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM card');
    const ins = db.prepare(
      'INSERT INTO card(word,sense_id,tier,is_trap,n_sent) VALUES(?,?,?,?,?)');
    for (const c of bundle.cards) {
      ins.run(c.w, c.s, c.tier || '', c.trap ? 1 : 0, (c.rows || []).length);
    }
    setMeta(db, 'bundle_version', bundle.version);
    setMeta(db, 'bundle_senses', bundle.cards.length);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return bundle.cards.length;
}

/** bundle 换了或 card 表空了就重建；否则跳过。 */
export function syncBundle(db, bundle) {
  const n = db.prepare('SELECT COUNT(*) n FROM card').get().n;
  const ver = getMeta(db, 'bundle_version');
  if (n === bundle.cards.length && ver === bundle.version) return 0;
  return rebuildCards(db, bundle);
}

/**
 * 会话排布：到期卡按权重排序（03 §5.2）。
 * decayIfIdle 在读取时惰性生效，不写库。
 */
export function layout(db, params, limit = 20, nowSec = now()) {
  const rows = db.prepare(
    `SELECT * FROM v_due
      ORDER BY 0.5 * wrong_n
             + 0.3 * is_trap
             + 0.2 * (1.0 - MIN(1.0, stability / 180.0)) DESC,
               word ASC, sense_id ASC
      LIMIT ?`).all(limit).map((r) => decayIfIdle(params, r, nowSec));
  return rows.sort((a, b) => weight(params, b) - weight(params, a));
}

export const now = () => Math.floor(Date.now() / 1000);

export function getState(db, word, senseId) {
  return db.prepare(
    'SELECT * FROM card_state WHERE word = ? AND sense_id = ?').get(word, senseId);
}

function recentResults(db, word, senseId, n) {
  return db.prepare(
    'SELECT result FROM review_log WHERE word = ? AND sense_id = ? ' +
    'ORDER BY ts DESC, rowid DESC LIMIT ?').all(word, senseId, n).map((r) => r.result);
}

/**
 * 提交一次作答。**单事务 + 幂等**：
 *   review_log 的主键 (session_id, idx) 是闸门，重复提交只会拿到 changes()=0，
 *   此时不碰 card_state —— 否则网络重试/双击会让 S 凭空翻倍。
 */
export function commitAnswer(db, params, bundle, answer) {
  const { sessionId, idx, word, senseId, result, elapsedMs, isDue = 1 } = answer;
  // attempt_id 是幂等闸门。缺省时退回 (session_id, idx)，够单机测试用；
  // 走 HTTP 时必须由 /api/next 下发并带回，否则重试会把一次作答记两遍。
  const attemptId = answer.attemptId ?? `${sessionId}#${idx}`;
  const ts = answer.ts ?? now();

  const card = bundle.cards.find((c) => c.w === word && c.s === senseId);
  if (!card) throw new Error(`bundle 里没有这张卡: ${word}#${senseId}`);

  const nSenses = bundle.cards.filter((c) => c.w === word).length;
  const meta = {
    sense_id: senseId,
    tier: card.tier || '',
    is_trap: card.trap ? 1 : 0,
    n_senses: nSenses,
  };

  const prev = getState(db, word, senseId);
const st = prev || {
    stability: 0, difficulty: 8, reps: 0, wrong_n: 0, due_at: 0,
    pending_n: 0, mastered: 0, rusty: 0, last_review: null,
  };
  const next = applyReview(params, { ...st, last_review: st.last_review },
    meta, result, elapsedMs, ts);

  // 连续答对次数：从本次作答往回数，遇到非 CORRECT 即停。
  // 注意必须在写 review_log **之前**读，所以把本次 result 拼在前面。
  const before = recentResults(db, word, senseId, 8);
  const seq = [result, ...before];
  let streak = 0;
  for (const r of seq) { if (r !== 'CORRECT') break; streak++; }
  // 答错要把掌握标记打回去：mastered=1 的卡被 v_due 永久排除，
  // 不清零的话一次答错就等于这张卡被移出复习计划。
  const mastered = result === 'WRONG'
    ? 0
    : (isMastered(params, { ...st, ...next }, streak, seq) ? 1 : 0);

  db.exec('BEGIN');
  try {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO review_log
         (session_id, idx, attempt_id, word, sense_id, result, grade, elapsed_ms,
          is_due, stability_after, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const r = ins.run(sessionId, idx, attemptId, word, senseId, result, next.grade,
      elapsedMs ?? null, isDue, next.stability, ts);
    if (r.changes === 1) {
      db.prepare(
        `INSERT INTO card_state
           (word, sense_id, stability, difficulty, last_review, due_at, reps,
            wrong_n, pending_n, mastered, rusty)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(word, sense_id) DO UPDATE SET
           stability = excluded.stability,
           difficulty = excluded.difficulty,
           last_review = excluded.last_review,
           due_at = excluded.due_at,
           reps = excluded.reps,
           wrong_n = excluded.wrong_n,
           pending_n = excluded.pending_n,
           mastered = excluded.mastered,
           rusty = excluded.rusty`)
        .run(word, senseId, next.stability, next.difficulty, ts, next.dueAt, next.reps,
          next.wrong_n, next.pending_n, mastered, 0);
    }
    db.exec('COMMIT');
    return {
      applied: r.changes === 1,
      grade: next.grade,
      kind: next.kind,
      stability: next.stability,
      difficulty: next.difficulty,
      intervalDays: next.intervalDays,
      dueAt: next.dueAt,
      sameDay: next.sameDay,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 首页概览（04-使用体验 §1 要的那几个数）。 */
/* ─────────────────────────────────────────────────────────
   tools/index.html 的存档层
   那份原型的 state 是一个小 JSON（queue/pos/stats/wrong/mastered/rowIdx），
   原来只存 localStorage。这里存一份到 SQLite，作用是：
     · localStorage 被清 / 换浏览器 / 换机器后能恢复
     · SRS 的原始输入（每次作答）不依赖前端
   前端仍以 localStorage 为准，这里只做镜像 + 恢复。
   ───────────────────────────────────────────────────────── */

export function saveUiState(db, obj) {
  db.prepare(
    `INSERT INTO ui_state(key, value, ts) VALUES('main', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts`)
    .run(JSON.stringify(obj), now());
}

export function loadUiState(db) {
  const row = db.prepare("SELECT value, ts FROM ui_state WHERE key = 'main'").get();
  if (!row) return null;
  try {
    return { state: JSON.parse(row.value), ts: row.ts };
  } catch {
    return null;
  }
}

export function clearUiState(db) {
  db.exec("DELETE FROM ui_state");
}

/**
 * 记一次作答（tools/index.html 的入口）。
 * 与 commitAnswer 的区别：那边有会话队列做幂等键，这边没有 ——
 * 前端用 answered 标志保证一次点击只发一次，所以 attempt_id 用随机串。
 *
 * session_id 固定 'ui'、idx 用子查询自增：这份 UI 没有"场次"的概念，
 * 但 review_log 的主键是 (session_id, idx)，硬编码 idx=0 会让
 * 第二道题起就撞主键被 INSERT OR IGNORE 静默吞掉（一次实测漏记 2 次作答）。
 */
export function recordAnswer(db, params, bundle, a) {
  const card = bundle.cards.find((c) => c.w === a.word && c.s === a.senseId);
  if (!card) throw new Error(`bundle 里没有这张卡: ${a.word}#${a.senseId}`);
  const nSenses = bundle.cards.filter((c) => c.w === a.word).length;
  const meta = {
    sense_id: a.senseId, tier: card.tier || '',
    is_trap: card.trap ? 1 : 0, n_senses: nSenses,
  };
  const prev = getState(db, a.word, a.senseId);
  const st = prev || {
    stability: 0, difficulty: 8, reps: 0, wrong_n: 0, due_at: 0,
    pending_n: 0, mastered: 0, rusty: 0, last_review: null,
  };
  const ts = a.ts ?? now();
  const next = applyReview(params, { ...st }, meta, a.result, a.elapsedMs ?? null, ts);
  const attemptId = 'ui-' + Math.random().toString(36).slice(2, 10);

  db.exec('BEGIN');
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO review_log
         (session_id, idx, attempt_id, word, sense_id, result, grade, elapsed_ms,
          is_due, stability_after, ts)
       VALUES ('ui',
               (SELECT COALESCE(MAX(idx), -1) + 1 FROM review_log WHERE session_id = 'ui'),
               ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(attemptId, a.word, a.senseId, a.result, next.grade,
        a.elapsedMs ?? null, next.stability, ts);
    if (r.changes === 1) {
      db.prepare(
        `INSERT INTO card_state
           (word, sense_id, stability, difficulty, last_review, due_at, reps,
            wrong_n, pending_n, mastered, rusty)
         VALUES (?,?,?,?,?,?,?,?,?,0,0)
         ON CONFLICT(word, sense_id) DO UPDATE SET
           stability = excluded.stability,
           difficulty = excluded.difficulty,
           last_review = excluded.last_review,
           due_at = excluded.due_at,
           reps = excluded.reps,
           wrong_n = excluded.wrong_n,
           pending_n = excluded.pending_n,
           mastered = 0`)
        .run(a.word, a.senseId, next.stability, next.difficulty, ts, next.dueAt,
          next.reps, next.wrong_n, next.pending_n);
    }
    db.exec('COMMIT');
    // return 必须在 try 块内：r 声明在块里（与 commitAnswer 同构）
    return {
      applied: r.changes === 1,
      stability: next.stability,
      difficulty: next.difficulty,
      intervalDays: next.intervalDays,
      dueAt: next.dueAt,
      kind: next.kind,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 用户手动标「我已学会」：置 mastered 并按 S>=90 天重排到期。 */
export function setMastered(db, params, bundle, word, senseId, on) {
  const card = bundle.cards.find((c) => c.w === word && c.s === senseId);
  if (!card) throw new Error(`bundle 里没有这张卡: ${word}#${senseId}`);
  const ts = now();
  db.prepare(
    `INSERT INTO card_state (word, sense_id, stability, difficulty, last_review,
                             due_at, reps, wrong_n, pending_n, mastered, rusty)
     VALUES (?,?,?,?,?,?,?,0,0,?,0)
     ON CONFLICT(word, sense_id) DO UPDATE SET
       mastered = excluded.mastered,
       stability = MAX(card_state.stability, excluded.stability),
       due_at = MAX(card_state.due_at, excluded.due_at)`)
    .run(word, senseId,
      on ? P_MASTER_S : 0, P_MASTER_D, ts, on ? ts + P_MASTER_S * 86400 : 0,
      on ? P_MASTER_REPS : 0, on ? 1 : 0);
  return { word, senseId, mastered: on ? 1 : 0 };
}

// 手动标记用的常量：与 srs_params.tsv 的 MASTER_S / MASTER_STREAK 语义对齐，
// 但这里不需要依赖参数文件（手动标记是用户的显式声明，不是算法推出来的）。
const P_MASTER_S = 90;
const P_MASTER_D = 5.0;
const P_MASTER_REPS = 6;

/* ─────────────────────────────────────────────────────────
   句子标记：有问题就标一下，可以写句备注。标了就不再出这句。
   事后跑 scripts/triage_flags.py 拿清单统一改。
   ───────────────────────────────────────────────────────── */

/** 标一句有问题。幂等：同一句只记一条，重复标只是更新备注。 */
export function flagSentence(db, bundle, f) {
  const card = bundle.cards.find((c) => c.w === f.word && c.s === f.senseId);
  if (!card) throw new Error(`bundle 里没有这张卡: ${f.word}#${f.senseId}`);
  if (!card.rows.some((r) => r.t === f.sentence)) {
    throw new Error('这句不在该义项的句子里');
  }
  db.prepare(
    `INSERT INTO sentence_flag (word, sense_id, sentence, note, ts) VALUES (?,?,?,?,?)
     ON CONFLICT(word, sense_id, sentence) DO UPDATE SET
       note = excluded.note, ts = excluded.ts`)
    .run(f.word, f.senseId, f.sentence, f.note || null, now());
  return { ok: true, total: flaggedCount(db) };
}

export function flaggedCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM sentence_flag').get().n;
}

export function listFlags(db, limit = 500) {
  return db.prepare(
    'SELECT word, sense_id, sentence, note, ts FROM sentence_flag ' +
    'ORDER BY ts DESC LIMIT ?').all(limit);
}

/** 键用空格分隔三段，避免拼接歧义。 */
export function flaggedSet(db) {
  const s = new Set();
  for (const r of db.prepare('SELECT word, sense_id, sentence FROM sentence_flag').all()) {
    s.add(r.word + ' ' + r.sense_id + ' ' + r.sentence);
  }
  return s;
}

/**
 * 本轮队列：到期卡按 SRS 权重排序（03 §5.2），跳过已无干净句子的卡。
 *   ids  = 有序卡 id
 *   live = 每个卡还能用的句子下标（被标记的已剔除）
 */
export function queue(db, bundle, params, limit = 20) {
  const flagged = flaggedSet(db);
  const rows = db.prepare('SELECT word, sense_id, is_trap, wrong_n FROM v_due').all();
  const out = [];
  for (const r of rows) {
    const card = bundle.cards.find((c) => c.w === r.word && c.s === r.sense_id);
    if (!card) continue;
    const idx = [];
    card.rows.forEach((row, i) => {
      if (!flagged.has(r.word + ' ' + r.sense_id + ' ' + row.t)) idx.push(i);
    });
    if (!idx.length) continue;
    out.push({ id: r.word + '#' + r.sense_id, w: weight(params, r), idx });
  }
  out.sort((a, b) => b.w - a.w || a.id.localeCompare(b.id));
  const picked = out.slice(0, limit);
  const live = {};
  for (const x of picked) live[x.id] = x.idx;
  return { ids: picked.map((x) => x.id), live, dueTotal: out.length };
}

export function overview(db, params, nowSec = now()) {
  const pool = db.prepare('SELECT COUNT(*) n FROM v_pool').get().n;
  const due = db.prepare('SELECT COUNT(*) n FROM v_due').get().n;
  const mastered = db.prepare('SELECT COUNT(*) n FROM card_state WHERE mastered = 1').get().n;
  const wrong = db.prepare('SELECT COUNT(*) n FROM v_wrong').get().n;
  const answered = db.prepare('SELECT COUNT(*) n FROM review_log').get().n;
  const acc = db.prepare('SELECT * FROM v_accuracy LIMIT 14').all();
  const tomorrow = db.prepare(
    `SELECT COUNT(*) n FROM v_pool
      WHERE mastered = 0
        AND due_at > CAST(strftime('%s','now') AS INTEGER) + 86400`).get().n;
  return { pool, due, mastered, wrong, answered, accuracy: acc, notDueTomorrow: tomorrow };
}

/** 取题：bundle 里该义项的句子按指纹轮转，避免同场重复。 */
export function pickSentence(bundle, word, senseId, idx = 0) {
  const card = bundle.cards.find((c) => c.w === word && c.s === senseId);
  if (!card || !card.rows.length) return null;
  const row = card.rows[idx % card.rows.length];
  return {
    text: row.t,
    clue: row.c,
    spanStart: row.ss,
    spanLen: row.sl,
    translation: row.tr,
    note: row.n,
    gloss: card.zh,
    pos: card.pos,
  };
}

/** 干扰项：同词优先，其余从 glossPool 抽，保证 4 选 1 里只有 1 个对。 */
export function buildOptions(bundle, card, n = 4) {
  const sameWord = bundle.cards
    .filter((c) => c.w === card.w && c.zh && c.zh !== card.zh)
    .map((c) => c.zh);
  const pool = bundle.glossPool.filter((z) => z !== card.zh);
  const out = [card.zh];
  const seen = new Set(out);
  for (const z of [...shuffle(sameWord), ...shuffle(pool)]) {
    if (out.length >= n) break;
    if (seen.has(z)) continue;
    seen.add(z);
    out.push(z);
  }
  return shuffle(out);
}

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}