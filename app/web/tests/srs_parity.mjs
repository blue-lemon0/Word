/** SRS 移植一致性 —— app/web/src/srs.ts（浏览器版） vs app/srs.mjs（参照实现）
 *
 *  为什么必须有这个测试：srs.ts 的文件头声称「公式与参数一字不改」。
 *  这句话不能靠自觉，得每轮机械比一遍：随机生成几百条作答序列，
 *  两边算出的 S / D / 间隔 / 评级 / 掌握判定必须逐个相同。
 *  只要有一条对不上，就说明旧进度接不上、复习间隔会突变。
 *
 *  跑法（仓库根）：node app/web/tests/srs_parity.mjs
 */
import { build } from 'esbuild'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const REPO = path.resolve(WEB, '..', '..')

const ref = await import(pathToFileURL(path.join(REPO, 'app', 'srs.mjs')).href)
const P = ref.loadParams()

/* 1. 参数 JSON 必须与 TSV 同源（scripts/params2json.py 生成，但会被手改） */
const json = JSON.parse(readFileSync(path.join(WEB, 'src', 'srs_params.json'), 'utf8'))
const paramBad = Object.keys(json).filter((k) => Number(json[k]) !== Number(P[k]))
ok(paramBad.length === 0, `srs_params.json 与 srs_params.tsv 一致（${Object.keys(json).length} 项）`,
   `不一致: ${paramBad.join(', ')}`)

/* 2. 打包 TS 版进临时文件再 import —— 免装 TS 运行器 */
const out = path.join(mkdtempSync(path.join(tmpdir(), 'srs-')), 'srs.mjs')
await build({
  entryPoints: [path.join(WEB, 'src', 'srs.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const port = await import(pathToFileURL(out).href)

/* 3. 随机序列逐格比对 */
const TIERS = ['T1', 'T2', 'T3', 'T4', '']
const RESULTS = ['CORRECT', 'CORRECT', 'CORRECT', 'WRONG', 'PENDING']
let seed = 20261017
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

let cases = 0
let diffs = 0
let diffDetail = ''
for (let c = 0; c < 400; c++) {
  const card = {
    is_trap: rnd() < 0.2 ? 1 : 0,
    tier: TIERS[Math.floor(rnd() * TIERS.length)],
    n_senses: 1 + Math.floor(rnd() * 5),
    sense_id: `s${1 + Math.floor(rnd() * 4)}`,
  }
  let a = { stability: 0, difficulty: 8, reps: 0, wrong_n: 0, pending_n: 0, last_review: null }
  let b = { stability: 0, difficulty: 8, reps: 0, wrong_n: 0, pending_n: 0, last_review: null }
  let now = 1758000000
  for (let i = 0; i < 12; i++) {
    const result = RESULTS[Math.floor(rnd() * RESULTS.length)]
    const elapsed = Math.floor(rnd() * 12000)
    const ra = ref.applyReview(P, a, card, result, elapsed, now)
    const rb = port.applyReview(b, card, result, elapsed, now)
    cases++
    for (const k of ['stability', 'difficulty', 'intervalDays', 'grade', 'reps']) {
      if (Math.abs(ra[k] - rb[k]) > 1e-9) {
        diffs++
        if (diffs < 5) diffDetail += `case${c} step${i} ${k}: ${ra[k]} vs ${rb[k]} `
      }
    }
    if (ra.wrong_n !== rb.wrongN || ra.pending_n !== rb.pendingN) {
      diffs++
      if (diffs < 5) diffDetail += `case${c} step${i} 计数: ${ra.wrong_n}/${ra.pending_n} vs ${rb.wrongN}/${rb.pendingN} `
    }
    if (Math.abs(ra.dueAt - rb.dueAt) > 1) {
      diffs++
      if (diffs < 5) diffDetail += `case${c} step${i} dueAt: ${ra.dueAt} vs ${rb.dueAt} `
    }
    if (ra.kind !== rb.kind) {
      diffs++
      if (diffs < 5) diffDetail += `case${c} step${i} kind: ${ra.kind} vs ${rb.kind} `
    }
    // 参照实现的状态用蛇形字段（srs.mjs 的约定），两边的 state 形状本来就不同
    a = {
      stability: ra.stability,
      difficulty: ra.difficulty,
      reps: ra.reps,
      wrong_n: ra.wrong_n,
      pending_n: ra.pending_n,
      last_review: now,
    }
    b = {
      stability: rb.stability,
      difficulty: rb.difficulty,
      reps: rb.reps,
      wrong_n: rb.wrongN,
      pending_n: rb.pendingN,
      last_review: now,
    }
    now += 86400 + Math.floor(rnd() * 40000) // 隔开 >6h，避免同日重复因子干扰比对
  }
}
ok(diffs === 0, `${cases} 次作答的 S/D/间隔/评级/类型判定逐格一致`, diffDetail)

/* 4. 端点与单调性 */
ok(Math.abs(port.easeFactor(1) - ref.easeFactor(P, 1)) < 1e-12, 'ease_factor(D=1) 一致')
ok(Math.abs(port.easeFactor(10) - ref.easeFactor(P, 10)) < 1e-12, 'ease_factor(D=10) 一致')
let mono = true
for (let d = 1; d < 10; d++) if (!(port.easeFactor(d) > port.easeFactor(d + 1))) mono = false
ok(mono, 'ease_factor 单调递减')

/* 5. 掌握判定一致 */
const rows = [
  { stability: 95, reps: 7, pending_n: 0 },
  { stability: 95, reps: 7, pending_n: 1 },
  { stability: 20, reps: 7, pending_n: 0 },
  { stability: 95, reps: 2, pending_n: 0 },
]
let mBad = 0
rows.forEach((row, i) => {
  const recent = i % 2 ? ['CORRECT', 'WRONG'] : ['CORRECT', 'CORRECT', 'CORRECT', 'CORRECT']
  const a = ref.isMastered(P, row, 3, recent)
  const b = port.isMastered(row, 3, recent)
  if (a !== b) mBad++
})
ok(mBad === 0, 'isMastered 四种情形判定一致')

/* ── 输出 ── */
function ok(cond, msg, detail = '') {
  if (cond) {
    console.log(`  PASS  ${msg}`)
  } else {
    console.log(`  FAIL  ${msg}${detail ? '  → ' + detail : ''}`)
    process.exitCode = 1
  }
}

if (!process.exitCode) console.log('\nSRS 移植一致性：全绿')