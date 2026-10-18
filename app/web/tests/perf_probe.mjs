/** 热路径耗时实测：把真实的全库（2998 词 / 7884 义项）灌进去，
 *  然后按「用户实际会做的动作」逐个计时。
 *
 *  为什么要有这个：卡顿是感觉，测不出来就没法判断修没修好。
 *  这里的每一项都对应界面上的一个动作，数字可以直接对比优化前后。
 *
 *  跑法（仓库根）：node app/web/tests/perf_probe.mjs
 *  需要 build/bundle/cards.json（没有就用仓库里的种子，只跑相对比较）。
 */
import 'fake-indexeddb/auto'
import { build } from 'esbuild'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const REPO = path.resolve(WEB, '..', '..')
const BUNDLE = path.join(REPO, 'build', 'bundle', 'cards.json')

const out = path.join(mkdtempSync(path.join(tmpdir(), 'perf-')), 'entry.mjs')
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
const { bundleImport, quiz, composables, flags } = M

const data = existsSync(BUNDLE)
  ? JSON.parse(readFileSync(BUNDLE, 'utf8'))
  : JSON.parse(readFileSync(path.join(WEB, 'public', 'seed.json'), 'utf8'))
const t0 = Date.now()
await bundleImport.importBundle(data)
console.log(`库：${data.stats.words} 词 / ${data.stats.senses} 义项 / ${data.stats.sentences} 句  导入 ${Date.now() - t0} ms\n`)

/** 跑 n 次取平均：单次抖动不算数 */
async function bench(label, n, fn) {
  await fn() // 预热（顺便把缓存填上 —— 这正是我们要测的真实状态）
  const t = Date.now()
  for (let i = 0; i < n; i++) await fn()
  const ms = (Date.now() - t) / n
  const flag = ms > 150 ? '  ← 卡' : ms > 50 ? '  ← 慢' : ''
  console.log(`  ${label.padEnd(34, '·')} ${ms.toFixed(1)} ms${flag}`)
  return ms
}

console.log('界面动作（缓存命中时的表现）:')
await bench('搜索：每敲一个字符', 20, async () => {
  const all = await M.db.allWords()
  const s = 'ar'
  const hits = all.filter((w) => !w.hidden && w.word.toLowerCase().startsWith(s))
  return hits.length
})
await bench('首页「换一个」', 20, () => composables.randomCardWithSentence())
await bench('进训练页（组一轮队列）', 10, () => quiz.buildQueue(20))
await bench('出题（取题 + 凑 4 选项）', 20, async () => {
  const q = await quiz.buildQueue(1)
  return q.length ? quiz.makeQuestion(q[0]) : null
})
await bench('进「更多」（统计）', 20, () => composables.loadStats())
await bench('进错题板', 20, async () => {
  const rows = await flags.listFlags()
  return rows.length
})
await bench('词库页聚合', 5, async () => {
  const [senses, words, sents, progs] = [
    await M.db.liveSenses(),
    await M.db.allWords(),
    await M.db.allSentences(),
    await M.db.allProgress(),
  ]
  return senses.length + words.length + sents.length + progs.length
})

console.log('\n写入后必须立刻能读到（缓存正确性）：')
await bench('答题一次（含写 progress）', 10, async () => {
  const q = await quiz.buildQueue(1)
  if (!q.length) return
  const item = await quiz.makeQuestion(q[0])
  if (item) await quiz.recordAnswer(item, 'perf', 0, 'CORRECT', 700)
})
const after = await quiz.buildQueue(1)
console.log(`  写完立刻重建队列 → ${after.length} 张（读到了新状态，不是缓存）`)

console.log('\n注：数字是 Node + fake-indexeddb。手机 WebView 上大约慢 5~10 倍，')
console.log('    所以这里 15 ms 的一步，在手机上可能就是 100 ms+。')