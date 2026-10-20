/** 全库规模的一次性测量：把真实的 build/bundle/cards.json 灌进 IndexedDB，
 *  再跑一遍词库页的聚合逻辑，看打开词库要多久、内存里有多大。
 *  不是回归测试，是选型时的一次性体检（跑法：node app/web/tests/scale_probe.mjs）。
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

if (!existsSync(BUNDLE)) {
  console.log('没有 build/bundle/cards.json —— 本机历史产物（内容产线已删除，git 历史可查）')
  process.exit(0)
}

const out = path.join(mkdtempSync(path.join(tmpdir(), 'scale-')), 'entry.mjs')
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
const { bundleImport, composables } = M

const json = JSON.parse(readFileSync(BUNDLE, 'utf8'))
let t = Date.now()
const rep = await bundleImport.importBundle(json)
console.log(`导入：词+${rep.wordsAdded} 义+${rep.sensesAdded} 句+${rep.sentencesAdded}  用时 ${Date.now() - t} ms`)

t = Date.now()
const [all, wrows, srows, prows] = await Promise.all([
  db.senses.filter((s) => s.deletedAt == null).toArray(),
  db.words.toArray(),
  db.sentences.toArray(),
  db.progress.toArray(),
])
console.log(`全表读：${all.length} 义项 / ${wrows.length} 词 / ${srows.length} 句 / ${prows.length} 进度  用时 ${Date.now() - t} ms`)

t = Date.now()
const byWord = new Map()
for (const s of all) {
  const a = byWord.get(s.word)
  if (a) a.push(s)
  else byWord.set(s.word, [s])
}
console.log(`词库页聚合：${byWord.size} 行  用时 ${Date.now() - t} ms`)

t = Date.now()
const stats = await composables.loadStats()
console.log(`统计（更多页）：${JSON.stringify(stats)}  用时 ${Date.now() - t} ms`)

t = Date.now()
const queue = await M.quiz.buildQueue(20)
console.log(`组一轮队列：${queue.length} 张  用时 ${Date.now() - t} ms`)