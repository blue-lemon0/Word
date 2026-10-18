/** Dexie 版本升级回归 —— 复现一次真实事故：
 *
 *   加了一张 snapshots 表，直接改在 version(1) 的定义里 → 已装过旧版的用户
 *   库里既没有这张表、代码又以为有 → 所有读写静默抛异常，
 *   表现是「点义项进不去」「读取失败」，跟数据库毫无关系，极难定位。
 *
 *   这个测试按事故原样重演一遍：先造一个 v1 旧库并写入真实数据，
 *   再用**当前的**应用代码打开它 —— 必须能自动升级、数据不丢、新表可用。
 *
 * 跑法（仓库根）：node app/web/tests/schema_upgrade.mjs
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')

let bad = 0
function ok(cond, msg, detail = '') {
  if (cond) console.log(`  PASS  ${msg}`)
  else {
    bad++
    console.log(`  FAIL  ${msg}${detail ? '  → ' + detail : ''}`)
  }
}

/* ── 1. 造一个「旧版本」的库（v1，没有 snapshots 表）── */
const V1 = {
  words: 'word, hidden, updatedAt',
  senses: 'id, word, [word+slot], deletedAt, needsRefine, trap, tier',
  sentences: '++id, senseId, [senseId+idx]',
  progress: 'senseId, dueAt, mastered',
  reviewLog: '[sessionId+idx], senseId, ts',
  importLog: '++id, ts, word',
}

const OLD = {
  words: 'word, hidden, updatedAt',
  senses: 'id, word, [word+slot], deletedAt, needsRefine, trap, tier',
  sentences: '++id, senseId, [senseId+idx]',
  progress: 'senseId, dueAt, mastered',
  reviewLog: '[sessionId+idx], senseId, ts',
  importLog: '++id, ts, word',
}

const old = new Dexie('wordbank')
old.version(1).stores(OLD)
await old.open()
await old.words.put({ word: 'army', ipa: 'ˈɑːmi', hidden: 0, createdAt: 1, updatedAt: 1 })
await old.senses.put({
  id: 'old-sense-id-0001',
  word: 'army',
  slot: 1,
  pos: 'n.',
  gloss: '军队，陆军',
  glossEn: 'a military force',
  note: '',
  trap: 0,
  tier: 'T1',
  needsRefine: 0,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1,
})
await old.progress.put({
  senseId: 'old-sense-id-0001',
  stability: 3.2,
  difficulty: 5,
  lastReview: 100,
  dueAt: 200,
  reps: 3,
  wrongN: 1,
  pendingN: 0,
  mastered: 0,
  rusty: 0,
})
old.close()
console.log('  已造好 v1 旧库（1 词 / 1 义项 / 1 进度，无 snapshots 表）\n')

/* ── 2. 用当前的应用代码打开同一个库 ── */
const out = path.join(mkdtempSync(path.join(tmpdir(), 'up-')), 'entry.mjs')
await build({
  entryPoints: [path.join(HERE, 'entry.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)
const db = M.db.db

ok(db.verno >= 2, `应用声明的版本是 ${db.verno}（≥2）`)
ok(Object.keys(V1).length === 6, '测试基准：v1 有 6 张表')

const check = await M.db.verifySchema()
ok(check.ok, '启动自检通过（每张表都能读）', check.error ?? '')

/* ── 3. 数据必须还在 ── */
const keptSense = await db.senses.get('old-sense-id-0001')
ok(keptSense != null && keptSense.gloss === '军队，陆军', '旧义项还在，释义没丢')
const keptProg = await db.progress.get('old-sense-id-0001')
ok(keptProg != null && keptProg.stability === 3.2 && keptProg.reps === 3,
   '旧学习进度还在（S=3.2 reps=3）—— 升级绝不能丢进度')

/* ── 4. 新表必须可用 ── */
await db.snapshots.put({ ts: Date.now(), label: '升级后第一条', payload: '{}' })
ok((await db.snapshots.count()) === 1, 'v2 新增的 snapshots 表可写可读')

/* ── 5. 新代码的正常路径也要通 ── */
const id = await M.edit.addSense('army', '测试义项')
const added = await db.senses.get(id)
ok(added != null && added.gloss === '测试义项', '升级后能继续新增义项')
const pool = await M.quiz.practicePool()
ok(Array.isArray(pool), '出题池可用（不该因升级而报错）')

console.log(bad ? `\n${bad} 处失败` : '\n版本升级：全绿')
process.exitCode = bad ? 1 : 0