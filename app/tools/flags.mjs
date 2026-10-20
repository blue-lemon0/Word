// 问题句标记的关单工具 —— 闭环「背时标记 → 生成侧修复 → 发布 → 关单」。
//
//   node app/tools/flags.mjs list                     全量标记，对照当前内容包判定状态
//   node app/tools/flags.mjs list --json
//   node app/tools/flags.mjs purge-stale              删除「疑似已修」（句子已不在内容包）
//   node app/tools/flags.mjs resolve <word> <senseId> <句子前缀>
//                                                      手动关单（原文没变、只改译文那种修复）
//
// 可选 --db PATH 指定库（默认 app/state/user.db，即正在运行的服务用的同一个库）。
//
// 状态判定（依据当前 build/bundle/cards.json）：
//   OPEN   句子仍在内容包里 —— 还没修，继续出现在 triage 清单
//   STALE  卡已不存在，或该句原文已不在卡的句子里 —— 修复发布后自然失效，可清理
// 注意：只改译文、没改原文的修复，句子仍精确命中，状态是 OPEN —— 确认修好用 resolve 关单。
//
// 与运行中服务的关系：纯本地 SQLite，短事务 + busy_timeout，可在服务运行时执行；
// 标记表的改动下一次出题即生效（出题时实时读，不缓存）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadBundle, USER_DB } from '../db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SCHEMA_SQL = path.join(APP, 'schema.sql');

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { cmd, db: USER_DB, json: false, pos: [] };
  for (const x of rest) {
    if (x === '--json') a.json = true;
    else if (x === '--db') a._waitDb = true;
    else if (a._waitDb) { a.db = path.resolve(x); a._waitDb = false; }
    else a.pos.push(x);
  }
  return a;
}

function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  // 服务可能正持有同一库：写操作给 5 秒忙等，避免抢锁直接失败。
  db.exec('PRAGMA busy_timeout=5000');
  // 确保表存在（对仅含 schema 的新库也成立）。
  db.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
  return db;
}

/** 给每条标记挂上 OPEN/STALE 状态。 */
function classify(db, bundle) {
  const cards = new Map();
  for (const c of bundle.cards) cards.set(c.word + '#' + c.senseId, c);
  const rows = db.prepare(
    'SELECT word, sense_id AS senseId, sentence, note, ts ' +
    'FROM sentence_flag ORDER BY ts DESC').all();
  return rows.map((r) => {
    const card = cards.get(r.word + '#' + r.senseId);
    const status =
      !card ? 'STALE' :
      card.sentences.some((s) => s.text === r.sentence) ? 'OPEN' : 'STALE';
    return { ...r, status,
      reason: !card ? '卡已不在内容包' : (status === 'STALE' ? '句子原文已不在' : '') };
  });
}

function fmtTs(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cmdList(db, bundle, asJson) {
  const items = classify(db, bundle);
  if (asJson) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    return;
  }
  if (!items.length) { console.log('没有任何标记。'); return; }
  const open = items.filter((x) => x.status === 'OPEN');
  const stale = items.filter((x) => x.status === 'STALE');
  for (const x of items) {
    const tag = x.status === 'OPEN' ? '[待修]' : '[已修?]';
    console.log(`${tag} ${x.word}#${x.senseId}  ${fmtTs(x.ts)}` +
                (x.status === 'STALE' ? `  (${x.reason})` : ''));
    console.log(`      ${x.sentence}`);
    if (x.note) console.log(`      备注: ${x.note}`);
  }
  console.log(`\n合计 ${items.length} 条：待修 ${open.length}，疑似已修 ${stale.length}`);
  if (stale.length) {
    console.log('  疑似已修的可清理：node app/tools/flags.mjs purge-stale');
  }
  if (open.length) {
    console.log('  待修清单交人工/AI 修（原 triage_flags.py 已随内容产线删除）');
  }
}

function cmdPurgeStale(db, bundle) {
  const items = classify(db, bundle).filter((x) => x.status === 'STALE');
  if (!items.length) { console.log('没有疑似已修的标记，无需清理。'); return; }
  const del = db.prepare(
    'DELETE FROM sentence_flag WHERE word=? AND sense_id=? AND sentence=?');
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const x of items) {
      n += del.run(x.word, x.senseId, x.sentence).changes;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const x of items) {
    console.log(`已关单 ${x.word}#${x.senseId}：${x.sentence.slice(0, 50)}`);
  }
  console.log(`\n清理 ${n} 条疑似已修标记（这些句子已重新参与出题）。`);
}

function cmdResolve(db, pos) {
  const [word, senseId, prefix] = pos;
  if (!word || !senseId || !prefix) {
    console.error('用法: resolve <word> <senseId> <句子原文前缀（可只给开头几个字）>');
    process.exit(2);
  }
  // 不用 SQL LIKE：前缀里的 %/_/反斜杠转义容易出错，直接取该卡标记在 JS 里比。
  const hits = db.prepare(
    'SELECT sentence, note FROM sentence_flag WHERE word=? AND sense_id=?')
    .all(word, senseId)
    .filter((r) => r.sentence.startsWith(prefix));
  if (!hits.length) {
    console.error(`没有匹配 ${word}#${senseId} 前缀「${prefix}」的标记。` +
                  '先用 list 看原文（前缀区分大小写）。');
    process.exit(1);
  }
  if (hits.length > 1) {
    console.error(`前缀匹配到 ${hits.length} 条，请给更长的前缀：`);
    for (const h of hits) console.error('  ' + h.sentence);
    process.exit(1);
  }
  const info = db.prepare(
    'DELETE FROM sentence_flag WHERE word=? AND sense_id=? AND sentence=?')
    .run(word, senseId, hits[0].sentence);
  console.log(`已关单 ${word}#${senseId}：${hits[0].sentence}` +
              `（删除 ${info.changes} 行；若句子原文未变，它即刻恢复出题）`);
}

const a = parseArgs(process.argv.slice(2));
try {
  const db = openDb(a.db);
  try {
    if (a.cmd === 'list') {
      cmdList(db, loadBundle(), a.json);
    } else if (a.cmd === 'purge-stale') {
      cmdPurgeStale(db, loadBundle());
    } else if (a.cmd === 'resolve') {
      cmdResolve(db, a.pos);
    } else {
      console.error(
        '用法:\n' +
        '  node app/tools/flags.mjs list [--json]\n' +
        '  node app/tools/flags.mjs purge-stale\n' +
        '  node app/tools/flags.mjs resolve <word> <senseId> <句子前缀>\n' +
        '  [--db PATH]');
      process.exit(2);
    }
  } finally {
    db.close();
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
