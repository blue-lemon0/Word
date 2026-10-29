// 移植一致性验证：src/srs.ts  vs  app/srs.mjs
//
// 为什么必须做这个：
//   srs.ts 是从 srs.mjs 手工移植的。移植错一个数字，用户的复习间隔就会突变，
//   而且这种错误在正常使用下察觉不到 —— 要几个月后才发现「这词怎么突然天天出现」。
//   所以这里不只对固定黄金向量（2.0/4.1/8.3/16.8），
//   而是让两套实现在**同一串随机操作**上跑完整状态轨迹，逐字段比对。
//
// 用法：node app/web/scripts/verify_port.mjs
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const ROOT = path.resolve(WEB, '..', '..')

/* ── 1. 把 TS 转成临时 mjs ── */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srsport-'))
const tmpFile = path.join(tmpDir, 'srs.mjs')
await build({
  entryPoints: [path.join(WEB, 'src', 'srs.ts')],
  outfile: tmpFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'silent',
})

const oldSrs = await import(pathToFileURL(path.join(ROOT, 'app', 'srs.mjs')).href)
const newSrs = await import(pathToFileURL(tmpFile).href)

let failures = 0
const fail = (msg) => {
  failures++
  console.log('  \u2717 ' + msg)
}

/* ── 2. 参数一致性（params2json.py 是第一个可能出错的地方）── */
console.log('=== 1. 参数：srs_params.json  vs  loadParams(srs_params.tsv) ===')
const P_old = oldSrs.loadParams()
const P_new = newSrs.PARAMS
const keys = [...new Set([...Object.keys(P_old), ...Object.keys(P_new)])].sort()
let pBad = 0
for (const k of keys) {
  const a = P_old[k]
  const b = P_new[k]
  const same = typeof a === 'number' && typeof b === 'number' ? a === b : a === b
  if (!same) {
    pBad++
    fail(`参数 ${k}: tsv=${a}  json=${b}`)
  }
}
console.log(`  比对 ${keys.length} 个参数，${pBad} 个不一致`)
console.log(`  TSV 独有: ${keys.filter((k) => P_old[k] !== undefined && P_new[k] === undefined).join(',') || '无'}`)
console.log(`  JSON 独有: ${keys.filter((k) => P_old[k] === undefined && P_new[k] !== undefined).join(',') || '无'}`)

/* ── 3. 纯函数逐点比对 ── */
console.log('\n=== 2. easeFactor / classify / gradeFor ===')
let fBad = 0
for (let d = 0; d <= 12; d += 0.5) {
  if (oldSrs.easeFactor(P_old, d) !== newSrs.easeFactor(d)) {
    fBad++
    fail(`easeFactor(D=${d}): ${oldSrs.easeFactor(P_old, d)} vs ${newSrs.easeFactor(d)}`)
  }
}
console.log(`  D 取 0~12 步长 0.5，共 ${fBad} 处不一致`)

const CARDS = [
  { id: 'u1', sense_id: 's1', n_senses: 3, is_trap: 0, tier: 'T1' }, // MULTI_S1
  { id: 'u2', sense_id: 's2', n_senses: 3, is_trap: 0, tier: 'T1' }, // NEW
  { id: 'u3', sense_id: 's1', n_senses: 1, is_trap: 0, tier: 'T1' }, // SINGLE
  { id: 'u4', sense_id: 's1', n_senses: 2, is_trap: 1, tier: 'T1' }, // TRAP
  { id: 'u5', sense_id: 's1', n_senses: 1, is_trap: 0, tier: 'T4' }, // RARE
  { id: 'u6', sense_id: 's1', n_senses: 1, is_trap: 0, tier: 'T3' }, // RARE
  { id: 'u7', sense_id: 's3', n_senses: 1, is_trap: 0, tier: '' }, // SINGLE
]
const KINDS = ['TRAP', 'RARE', 'MULTI_S1', 'SINGLE', 'NEW']
for (const c of CARDS) {
  const a = oldSrs.classify(P_old, c)
  const b = newSrs.classify(c)
  if (a.kind !== b.kind || a.S0 !== b.S0 || a.D0 !== b.D0) {
    fBad++
    fail(`classify(${c.sense_id}/${c.n_senses}/trap=${c.is_trap}/${c.tier}): ${a.kind} vs ${b.kind}`)
  }
}
console.log(`  classify 覆盖 ${CARDS.length} 种卡片（${KINDS.join('/')}），累计 ${fBad} 处不一致`)

const RESULTS = ['CORRECT', 'WRONG', 'PENDING']
let gBad = 0
for (const r of RESULTS) {
  const a = oldSrs.gradeFor(P_old, r)
  const b = newSrs.gradeFor(r)
  if (a !== b) {
    gBad++
    fail(`gradeFor(${r}): ${a} vs ${b}`)
  }
}
console.log(`  gradeFor 覆盖 ${RESULTS.length} 种结果，累计 ${gBad} 处不一致`)

/* ── 4. 完整状态轨迹比对（核心）── */
console.log('\n=== 3. applyReview 随机轨迹：连续 2000 步，每步比对全字段 ===')

// 确定性 PRNG，保证失败可复现
let seed = 20261016
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const START = 1767225600 // 2026-01-01T00:00:00Z

let stOld = { stability: 0, difficulty: 8, reps: 0, wrong_n: 0, pending_n: 0, last_review: null }
let stNew = { ...stOld }
let t = START
let trajBad = 0
const STEPS = 2000

for (let i = 0; i < STEPS; i++) {
  const card = pick(CARDS)
  const result = pick(RESULTS)
  // 同日/跨日/长期不练 三种时间跨度都要覆盖
  const gap = pick([600, 3600, 6 * 3600, 20 * 3600, 3 * 86400, 30 * 86400, 400 * 86400])
  t += gap

  const a = oldSrs.applyReview(P_old, stOld, card, result, t)
  const b = newSrs.applyReview(stNew, card, result, t)

  for (const f of ['stability', 'difficulty', 'intervalDays', 'grade', 'dueAt', 'reps', 'kind', 'sameDay']) {
    if (a[f] !== b[f]) {
      trajBad++
      if (trajBad <= 5) {
        fail(`第 ${i} 步 ${f}: 旧=${a[f]} 新=${b[f]}  (${card.sense_id} ${result})`)
      }
    }
  }
  if (a.wrong_n !== b.wrongN || a.pending_n !== b.pendingN) {
    trajBad++
    if (trajBad <= 5) fail(`第 ${i} 步 wrong_n/pending_n: 旧=${a.wrong_n}/${a.pending_n} 新=${b.wrongN}/${b.pendingN}`)
  }

  stOld = {
    stability: a.stability,
    difficulty: a.difficulty,
    reps: a.reps,
    wrong_n: a.wrong_n,
    pending_n: a.pending_n,
    last_review: t,
  }
  stNew = { ...stOld }
}
console.log(`  ${STEPS} 步，累计 ${trajBad} 处不一致`)
console.log(`  终态: S=${stOld.stability.toFixed(4)} D=${stOld.difficulty.toFixed(4)} reps=${stOld.reps} wrong=${stOld.wrong_n}`)

/* ── 5. decayIfIdle / isMastered ── */
console.log('\n=== 4. decayIfIdle / isMastered ===')
let dBad = 0
for (const lr of [null, 0, START, START + 86400]) {
  for (const S of [0.5, 2, 8, 30, 180]) {
    for (const gap of [1, 10, 100, 5000]) {
      const rowOld = { last_review: lr, stability: S, rusty: 0 }
      const a = oldSrs.decayIfIdle(P_old, rowOld, START + gap)
      const b = newSrs.decayIfIdle(rowOld, START + gap)
      if (a.stability !== b.stability || !!a.rusty !== !!b.rusty) {
        dBad++
        fail(`decayIfIdle(lr=${lr}, S=${S}, gap=${gap}): ${a.stability} vs ${b.stability}`)
      }
    }
  }
}
console.log(`  decayIfIdle 累计 ${dBad} 处不一致`)

let mBad = 0
for (const S of [0, 1, 14, 30, 180]) {
  for (const reps of [0, 1, 3, 8]) {
    for (const streak of [null, 0, 2, 3, 5]) {
      for (const pn of [0, 1]) {
        for (const rec of [undefined, ['CORRECT', 'CORRECT'], ['CORRECT', 'WRONG']]) {
          const row = { stability: S, reps, pending_n: pn }
          const a = oldSrs.isMastered(P_old, row, streak, rec)
          const b = newSrs.isMastered(row, streak, rec)
          if (a !== b) {
            mBad++
            fail(`isMastered(S=${S},reps=${reps},streak=${streak},pn=${pn}): ${a} vs ${b}`)
          }
        }
      }
    }
  }
}
console.log(`  isMastered 累计 ${mBad} 处不一致`)

/* ── 6. 文档里的黄金向量仍然成立 ── */
console.log('\n=== 5. 文档黄金向量（app/tests/verify_srs.py §"连对 4 次"）===')
const docVec = [
  ['义项 s1', P_old.S0_MULTI_S1, P_old.D0_MULTI_S1],
  ['TRAP', P_old.S0_TRAP, P_old.D0_TRAP],
  ['单义', P_old.S0_SINGLE, P_old.D0_SINGLE],
  ['新词', P_old.S0_NEW, P_old.D0_NEW],
  ['低频', P_old.S0_RARE, P_old.D0_RARE],
]
for (const [name, s0, d0] of docVec) {
  let S = s0
  const row = []
  for (let i = 0; i < 4; i++) {
    const st = { stability: S, difficulty: d0, reps: 1, wrong_n: 0, pending_n: 0, last_review: START - 86400 }
    const card = { sense_id: 's1', n_senses: 1, is_trap: 0, tier: 'T1' }
    const r = newSrs.applyReview(st, card, 'CORRECT', START)
    row.push(r.intervalDays)
    S = r.stability
  }
  console.log(`  ${name.padEnd(10)} ${row.map((x) => x.toFixed(2)).join(' / ')}`)
}
console.log('  （对照 app/tests/verify_srs.py 的输出，两边必须逐位相同）')

fs.rmSync(tmpDir, { recursive: true, force: true })

console.log('\n' + '='.repeat(58))
if (failures === 0) {
  console.log('结论：全部一致 —— srs.ts 可以安全替换 srs.mjs')
} else {
  console.log(`结论：${failures} 处不一致，不要上线`)
  process.exit(1)
}
