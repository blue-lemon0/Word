/** 复习量预测（forecast.ts）的行为测试。
 *
 *  为什么必须有：预测是**推演**，错法不是报错而是「数字悄悄不对」——
 *  比如超窗卡被堆进最后一天、掌握了的卡还在排期。这些只能靠构造
 *  已知的合成进度、断言已知的形状来抓住。
 *
 *  跑法（仓库根）：node app/web/tests/forecast.mjs
 */
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')

let failures = 0
function ok(cond, label, detail = '') {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.error(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const out = path.join(mkdtempSync(path.join(tmpdir(), 'fc-')), 'forecast.mjs')
await build({
  entryPoints: [path.join(WEB, 'src', 'forecast.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const { forecastDaily, forecastSummary } = await import(pathToFileURL(out).href)

/** 造一条已学进度行 */
function row(senseId, { stability = 2, difficulty = 5, dueAt = NOW, reps = 1, mastered = 0 } = {}) {
  return {
    senseId,
    stability,
    difficulty,
    lastReview: NOW - 86400,
    dueAt,
    reps,
    wrongN: 0,
    pendingN: 0,
    mastered,
    rusty: 0,
  }
}

// 固定「今天中午」为 now，避免日界随跑测试的时刻漂移
const NOW = (() => {
  const d = new Date()
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime() / 1000)
})()

/* 1. 逾期卡落在今天 */
{
  const r = forecastDaily([row('a', { dueAt: NOW - 3 * 86400 })], NOW, 90)
  ok(r.counts[0] >= 1, '逾期的卡算在今天', `counts[0]=${r.counts[0]}`)
}

/* 2. 明天的卡在明天，且今天没有 */
{
  const r = forecastDaily([row('a', { dueAt: NOW + 86400 })], NOW, 90)
  ok(r.counts[0] === 0 && r.counts[1] === 1, '明天的卡只出现在明天',
     `d0=${r.counts[0]} d1=${r.counts[1]}`)
}

/* 3. 推演会产生**新的**到期：一张卡 90 天内不止出现一次 */
{
  const r = forecastDaily([row('a')], NOW, 90)
  const total = r.counts.reduce((x, y) => x + y, 0)
  ok(total > 1, '答完后间隔拉长、但 90 天内会再次到期', `total=${total}`)
}

/* 4. 已掌握的卡不再排期 */
{
  const r = forecastDaily([row('a', { mastered: 1 })], NOW, 90)
  ok(r.peakDay === -1 && r.counts.every((n) => n === 0), '已掌握的卡不进预测')
}

/* 5. 新卡（reps=0）不进预测 —— 它还没排期，排期是「学过之后」的事 */
{
  const r = forecastDaily([row('a', { reps: 0 })], NOW, 90)
  ok(r.peakDay === -1, '未开始学的卡不进预测')
}

/* 6. 掌握推演：高稳定度的卡连对几次后应从预测里消失
 *    （S≥90 且 reps≥6 即掌握 —— 给它 S=89，几次连对后越线） */
{
  const r = forecastDaily([row('a', { stability: 89, reps: 5 })], NOW, 365)
  const total = r.counts.reduce((x, y) => x + y, 0)
  ok(total <= 3, '接近掌握的卡几次连对后出列', `total=${total}`)
}

/* 7. 超窗卡不堆进最后一天：到期日在 120 天后的卡，90 天窗口里只该
 *    出现在它自己的位置（不在窗口内 = 一次都不出现） */
{
  const r = forecastDaily([row('a', { dueAt: NOW + 120 * 86400, stability: 200 })], NOW, 90)
  ok(r.peakDay === -1, '窗口外的卡不进预测，也不堆进第 90 天')
}

/* 8. 按词去重：同一个词的两张卡同一天到期，只算 1 个词 */
{
  const rows = [row('w1:s1'), row('w1:s2'), row('w2:s1')]
  const wordOf = (id) => id.split(':')[0]
  const r = forecastDaily(rows, NOW, 90, wordOf)
  ok(r.counts[0] === 2, '同一词多义项当天只计一次', `counts[0]=${r.counts[0]}`)
}

/* 9. 确定性：同一份输入算两遍，结果逐格相同 */
{
  const rows = [row('a'), row('b', { stability: 5 }), row('c', { dueAt: NOW + 7 * 86400 })]
  const r1 = forecastDaily(rows, NOW, 90)
  const r2 = forecastDaily(rows, NOW, 90)
  ok(JSON.stringify(r1) === JSON.stringify(r2), '推演结果确定（无随机）')
}

/* 10. 摘要句 */
{
  ok(forecastSummary({ counts: [0, 0], peakDay: -1, peakCount: 0 }) === '未来 90 天没有排期中的复习',
     '全零时的摘要不吹口哨')
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
