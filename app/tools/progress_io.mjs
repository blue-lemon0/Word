// 学习进度包导入导出工具 —— CONTRACT.md §2 的参考实现。
//
//   node app/tools/progress_io.mjs export [out.json] [--db app/state/user.db]
//   node app/tools/progress_io.mjs import <in.json> [--force] [--db app/state/user.db]
//
// 语义边界：这是「备份 / 换机恢复」，不是多端实时合并（见 CONTRACT.md §2.5）。
// 内容投影表 card 与视图不参与搬运；reviews/flags 只增去重，states 按锚点覆盖。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));          // app/tools
const APP = path.resolve(HERE, '..');                               // app
const SCHEMA_SQL = path.join(APP, 'schema.sql');
const DEFAULT_DB = path.join(APP, 'state', 'user.db');
const FORMAT = 'word-progress';
const SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { cmd, force: false, db: DEFAULT_DB, file: null };
  const others = [];
  for (const x of rest) {
    if (x === '--force') a.force = true;
    else if (x === '--db') { /* 下一个参数取值 */ a._waitDb = true; }
    else if (a._waitDb) { a.db = path.resolve(x); a._waitDb = false; }
    else others.push(x);
  }
  a.file = others[0] ? path.resolve(others[0]) : null;
  return a;
}

// ── 行 → 包：DB 的 0/1、snake_case 在边界转成布尔、camelCase ──────────
function stateFromRow(r) {
  return {
    word: r.word, senseId: r.sense_id,
    stability: r.stability, difficulty: r.difficulty,
    lastReview: r.last_review, dueAt: r.due_at,
    reps: r.reps, wrongN: r.wrong_n, pendingN: r.pending_n,
    mastered: !!r.mastered, rusty: !!r.rusty,
  };
}
function reviewFromRow(r) {
  return {
    sessionId: r.session_id, idx: r.idx, attemptId: r.attempt_id,
    word: r.word, senseId: r.sense_id, sentence: r.sentence,
    result: r.result, grade: r.grade, elapsedMs: r.elapsed_ms,
    isDue: !!r.is_due, stabilityAfter: r.stability_after, ts: r.ts,
  };
}
function flagFromRow(r) {
  return { word: r.word, senseId: r.sense_id, sentence: r.sentence,
           note: r.note, ts: r.ts };
}

function doExport(dbPath, outPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const meta = Object.fromEntries(
      db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    const pack = {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Math.floor(Date.now() / 1000),
      bundleVersion: meta.bundle_version ?? null,
      states: db.prepare('SELECT * FROM card_state ORDER BY word, sense_id')
                  .all().map(stateFromRow),
      reviews: db.prepare('SELECT * FROM review_log ORDER BY ts, session_id, idx')
                   .all().map(reviewFromRow),
      flags: db.prepare('SELECT * FROM sentence_flag ORDER BY ts, id')
                .all().map(flagFromRow),
      uiState: (() => {
        const row = db.prepare("SELECT value FROM ui_state WHERE key = 'main'").get();
        return row ? JSON.parse(row.value) : null;
      })(),
    };
    const text = JSON.stringify(pack, null, 2) + '\n';
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text);
      console.log(`已导出 ${pack.states.length} 状态 / ${pack.reviews.length} 流水 / ` +
                  `${pack.flags.length} 标记 → ${outPath}`);
    } else {
      process.stdout.write(text);
    }
  } finally {
    db.close();
  }
}

function assertHeader(p) {
  if (p.format !== FORMAT) {
    throw new Error(`格式标识 "${p.format}" ≠ "${FORMAT}"，不是学习进度包`);
  }
  if (p.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`schemaVersion ${p.schemaVersion} ≠ 工具支持的 ${SCHEMA_VERSION}`);
  }
}

function doImport(dbPath, inPath, force) {
  if (!fs.existsSync(inPath)) throw new Error(`进度包不存在: ${inPath}`);
  const p = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  assertHeader(p);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // 新库先建表；老库 CREATE IF NOT EXISTS 全部空转。
  db.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));

  const curBundle = db.prepare("SELECT value FROM meta WHERE key = 'bundle_version'").get();
  if (p.bundleVersion && curBundle && curBundle.value !== p.bundleVersion) {
    console.warn(`[警告] 进度来自内容包 ${p.bundleVersion}，当前库是 ${curBundle.value}；` +
                 '悬空锚点会被视图自动过滤（CONTRACT.md §2.5）');
  }

  const insReview = db.prepare(`
    INSERT OR IGNORE INTO review_log
      (session_id, idx, attempt_id, word, sense_id, sentence, result, grade,
       elapsed_ms, is_due, stability_after, ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const upsertState = db.prepare(`
    INSERT INTO card_state
      (word, sense_id, stability, difficulty, last_review, due_at, reps,
       wrong_n, pending_n, mastered, rusty)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(word, sense_id) DO UPDATE SET
      stability=excluded.stability, difficulty=excluded.difficulty,
      last_review=excluded.last_review, due_at=excluded.due_at,
      reps=excluded.reps, wrong_n=excluded.wrong_n, pending_n=excluded.pending_n,
      mastered=excluded.mastered, rusty=excluded.rusty`);
  const insFlag = db.prepare(`
    INSERT OR IGNORE INTO sentence_flag (word, sense_id, sentence, note, ts)
    VALUES (?,?,?,?,?)`);

  const counts = { reviewsIn: 0, reviewsSkip: 0, statesUp: 0,
                   flagsIn: 0, flagsSkip: 0 };
  db.exec('BEGIN');
  try {
    for (const r of p.reviews ?? []) {
      const info = insReview.run(
        r.sessionId, r.idx, r.attemptId, r.word, r.senseId, r.sentence ?? null,
        r.result, r.grade, r.elapsedMs ?? null, r.isDue ? 1 : 0,
        r.stabilityAfter ?? null, r.ts);
      if (info.changes) counts.reviewsIn++; else counts.reviewsSkip++;
    }
    for (const s of p.states ?? []) {
      upsertState.run(
        s.word, s.senseId, s.stability, s.difficulty, s.lastReview ?? null, s.dueAt,
        s.reps, s.wrongN, s.pendingN, s.mastered ? 1 : 0, s.rusty ? 1 : 0);
      counts.statesUp++;
    }
    for (const f of p.flags ?? []) {
      const info = insFlag.run(f.word, f.senseId, f.sentence, f.note ?? null, f.ts);
      if (info.changes) counts.flagsIn++; else counts.flagsSkip++;
    }
    if (p.uiState != null) {
      const existing = db.prepare("SELECT COUNT(*) n FROM ui_state WHERE key='main'").get().n;
      if (existing === 0 || force) {
        db.prepare(`INSERT INTO ui_state(key, value, ts) VALUES('main', ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts`)
          .run(JSON.stringify(p.uiState), Math.floor(Date.now() / 1000));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
  console.log(`导入完成：流水新增 ${counts.reviewsIn}（跳过重复 ${counts.reviewsSkip}），` +
              `状态写入 ${counts.statesUp}，标记新增 ${counts.flagsIn}` +
              `（跳过 ${counts.flagsSkip}）→ ${dbPath}`);
}

const a = parseArgs(process.argv.slice(2));
if (a.cmd === 'export') {
  doExport(a.db, a.file);
} else if (a.cmd === 'import') {
  if (!a.file) { console.error('用法: import <in.json> [--force] [--db PATH]'); process.exit(2); }
  doImport(a.db, a.file, a.force);
} else {
  console.error('用法:\n' +
    '  node app/tools/progress_io.mjs export [out.json] [--db PATH]\n' +
    '  node app/tools/progress_io.mjs import <in.json> [--force] [--db PATH]');
  process.exit(2);
}
