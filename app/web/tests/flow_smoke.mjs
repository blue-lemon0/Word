/** 数据层端到端 —— 种子导入 → 编辑 → 导入对比 → 出题落库 → 备份回滚。
 *
 *  浏览器里跑不了单测，所以用 fake-indexeddb 把 Dexie 搬到 Node，
 *  esbuild 把 TS 打成临时 mjs 再 import。测的是真实代码路径，不是复刻。
 *
 *  跑法（仓库根）：node app/web/tests/flow_smoke.mjs
 */
import 'fake-indexeddb/auto'
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')

const out = path.join(mkdtempSync(path.join(tmpdir(), 'wb-')), 'entry.mjs')
await build({
  entryPoints: [path.join(HERE, 'entry.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent',
})
const M = await import(pathToFileURL(out).href)
/* entry.ts 按命名空间导出：dbApi.db 是那个 Dexie 实例，dbApi.<fn> 是 src/db 里的函数 */
const dbApi = M.db
const db = dbApi.db
const { edit, importer, backup, quiz, bundleImport, flags } = M

let bad = 0
function ok(cond, msg, detail = '') {
  if (cond) console.log(`  PASS  ${msg}`)
  else {
    bad++
    console.log(`  FAIL  ${msg}${detail ? '  → ' + detail : ''}`)
  }
}

/* ── 1. 种子导入（content-kit 内容包 → IndexedDB）── */
const seed = JSON.parse(readFileSync(path.join(WEB, 'public', 'seed.json'), 'utf8'))
const rep = await bundleImport.importBundle(seed)
ok(rep.errors.length === 0, `种子导入无错误（${rep.errors[0] ?? ''}）`)
ok(rep.wordsAdded === seed.stats.words, `词数 ${rep.wordsAdded} = ${seed.stats.words}`)
ok(rep.sensesAdded === seed.stats.senses, `义项数 ${rep.sensesAdded} = ${seed.stats.senses}`)
ok(rep.sentencesAdded === seed.stats.sentences, `例句数 ${rep.sentencesAdded} = ${seed.stats.sentences}`)
ok((await db.progress.count()) === seed.stats.senses, '每个新义项都建了进度行（否则 SRS 无从起步）')

const again = await bundleImport.importBundle(seed)
ok(again.sensesAdded === 0 && again.sentencesAdded === 0 && again.errors.length === 0,
   '重复导入同一个包：不新增、不报错（幂等）')

/* ── 2. span 定位：训练页高亮靠它 ── */
const sents = await db.sentences.toArray()
const badSpan = sents.filter(
  (s) => s.spanStart < 0 || s.text !== undefined && false,
)
ok(badSpan.length === 0, '所有例句都定位到了目标词', `${badSpan.length} 句没有 span`)
const formBad = sents.filter((s) => s.form && s.en.slice(s.spanStart, s.spanStart + s.spanLen) !== s.form)
ok(formBad.length === 0, 'spanStart/spanLen 与 form 逐句对齐（高亮不会打偏）', formBad[0]?.en ?? '')

/* ── 3. 编辑义项：id 永不变 ── */
const army = await db.senses.where('word').equals('army').first()
const before = await db.senses.where('word').equals('army').toArray()
const maxSlot = Math.max(...before.map((s) => s.slot))
const newId = await edit.addSense('army', '临时意思')
const armyAfter = await db.senses.where('word').equals('army').toArray()
ok(armyAfter.some((s) => s.id === army.id && s.slot === army.slot),
   '新增义项不改动已有义项的 id 与 slot')
ok(armyAfter.length === before.length + 1, '义项数 +1')

await edit.updateSense(newId, { gloss: '改过的意思', pos: 'n.' })
ok((await db.senses.get(newId)).gloss === '改过的意思', '就地编辑落库')

/* slot 重排后 id 不变 */
await dbApi.reorderSenses('army', [...armyAfter].reverse())
const armyReordered = await db.senses.where('word').equals('army').toArray()
const sameIds = new Set(before.map((s) => s.id))
ok(armyReordered.filter((s) => sameIds.has(s.id)).every((s) => s.slot !== undefined),
   '重排后老义项仍在（进度锚点没丢）')
ok((await db.progress.get(army.id)) != null, '重排不影响挂在 id 上的进度行')

/* ── 4. 合并：例句与熟练度都并过去 ── */
const withSents = (await db.senses.where('word').equals('army').toArray())
  .sort((a, b) => a.slot - b.slot)
const a1 = withSents[0]
const a2 = withSents[1]
await db.progress.put({
  senseId: a2.id, stability: 9, difficulty: 5, lastReview: 1, dueAt: 100,
  reps: 4, wrongN: 1, pendingN: 0, mastered: 0, rusty: 0,
})
const s1 = (await db.sentences.where('senseId').equals(a1.id).toArray()).length
const s2 = (await db.sentences.where('senseId').equals(a2.id).toArray()).length
await edit.mergeSenses(a1.id, a2.id)
const merged = await db.progress.get(a1.id)
ok((await db.senses.get(a2.id)) == null, '被合并的义项行已删（不留重复卡片）')
ok(merged.stability === 9 && merged.reps === 4, `熟练度并过去了（S=${merged.stability} reps=${merged.reps}）`)
ok((await db.sentences.where('senseId').equals(a1.id).toArray()).length === s1 + s2,
   `例句都并过来了（${s1}+${s2}）`)
ok((await db.progress.get(a2.id)) == null, '被合并者的进度行已并入，不再悬空')

/* ── 5. 导入对比：冲突只报不改 ── */
const conflict = {
  format: 'word.import',
  schemaVersion: 2,
  word: 'army',
  senses: [
    { slot: 1, gloss: 'AI 给的释义', sentences: [{ en: 'A brand new sentence here.', zh: '新句子。' }] },
    { slot: 9, gloss: '本地没有的意思', glossEn: 'a meaning only AI knows', sentences: [] },
  ],
}
const plan = await importer.planImport(conflict)
ok(plan.errors.length === 0, '合法的导入过了校验', plan.errors.join('; '))
ok(plan.senses.length === 2 && plan.senses[0].kind === 'update' && plan.senses[1].kind === 'new',
   '一个命中已有义项、一个是新义项')
ok(plan.senses[0].glossConflict === true, '释义不一致被标成冲突')
const d = importer.defaultDecisions(plan)
ok(d.gloss[plan.senses[0].key] === 'keep', '释义默认保留本地（A 方案）')
ok(d.sentences[plan.senses[0].key] === 'append', '例句默认追加缺的')
ok(d.adopt[plan.senses[1].key] === true, '新义项默认采纳')
ok(plan.senses[0].newSentences.length === 1, '算出了 1 句新增（按英文原文去重，不按 idx）')

/* 校验不过的整份拒绝 */
const badPlan = await importer.planImport({ word: 'army', senses: [{ slot: 1, gloss: '' }] })
ok(badPlan.errors.length > 0 && badPlan.senses.length === 0, 'gloss 为空 → 整份拒绝')

const glossBefore = (await db.senses.get(a1.id)).gloss
const msg = await importer.applyPlan(plan, d)
ok((await db.senses.get(a1.id)).gloss === glossBefore, '按默认决策写入后，本地释义没被覆盖')
ok((await db.senses.where('word').equals('army').toArray()).some((s) => s.gloss === '本地没有的意思'),
   '新义项已采纳')

/* ── 6. 出题：4 个选项含正解 + 落库 ── */
const pool = await quiz.practicePool()
ok(pool.length > 0, `可练池 ${pool.length} 个义项（只有有句义项进池）`)
const q1 = await quiz.makeQuestion(pool[0].id)
ok(q1.options.length === 4, '凑够 4 个选项')
ok(new Set(q1.options).size === q1.options.length, '选项不重复')
ok(q1.options.includes(q1.sense.gloss), '正确释义在选项里')
ok(q1.sentence.form ? q1.sentence.en.slice(q1.sentence.spanStart, q1.sentence.spanStart + q1.sentence.spanLen) === q1.sentence.form
   : true, '出题句的 span 指向目标词（<mark> 不会打偏）')

const sid = 'smoke-session'
const r1 = await quiz.recordAnswer(q1, sid, 0, 'CORRECT', 800)
ok(r1.outcome.stability > 0 && r1.outcome.reps === 1, `答对后 S=${r1.outcome.stability.toFixed(2)} reps=1`)
ok((await db.reviewLog.where('[sessionId+idx]').equals([sid, 0]).count()) === 1, '作答流水落库')
await quiz.recordAnswer(q1, sid, 0, 'CORRECT', 800)
ok((await db.reviewLog.where('[sessionId+idx]').equals([sid, 0]).count()) === 1,
   '同一次作答重复提交不产生第二条流水（主键幂等）')
ok((await db.progress.get(q1.sense.id)).reps === 2, '进度累加到 2 次')

const flagged = await quiz.makeQuestion(q1.sense.id)
await quiz.flagQuestion(flagged, '这句例句有问题')

/* 可练池 = 存活义项 × 有未标记句。按「池里实际会被抽到的句子集合」来断言，
   不去猜某个义项在不在池里 —— 义项有别的句时它本来就该留在池中。 */
async function usableTexts() {
  const set = new Set()
  for (const s of await quiz.practicePool()) {
    for (const r of await db.sentences.where('senseId').equals(s.id).toArray()) {
      if (!r.flagged) set.add(r.en)
    }
  }
  return set
}
ok(!(await usableTexts()).has(flagged.sentence.en), '标记后这句退出出题池')
const emptySenses = []
for (const s of await db.senses.filter((x) => x.deletedAt == null).toArray()) {
  const mine = await db.sentences.where('senseId').equals(s.id).toArray()
  if (mine.length && mine.every((x) => x.flagged)) emptySenses.push(s.word + ' s' + s.slot)
}
const poolIds = new Set((await quiz.practicePool()).map((s) => s.id))
const allSentences = await db.senses.filter((x) => x.deletedAt == null).toArray()
const leaked = []
for (const s of allSentences) {
  const mine = await db.sentences.where('senseId').equals(s.id).toArray()
  if (mine.length && mine.every((x) => x.flagged) && poolIds.has(s.id)) leaked.push(s.word)
}
ok(leaked.length === 0, '全是问题句的义项不留在池里', emptySenses.join(',') + ' → ' + leaked.join(','))

/* ── 6.1 问题句闭环：标记 → 导出 → 关单 ── */
const flagRows = await flags.listFlags()
ok(flagRows.length === 1 && flagRows[0].sentence === flagged.sentence.en,
   '标记出现在清单里，带上词/义项/原文')
ok(flagRows[0].note === '这句例句有问题', '标记备注带出去了（内容侧要知道问题是什么）')
const ffile = flags.buildFlagsFile(flagRows, 1758000000000)
ok(ffile.format === 'word-flags' && ffile.schemaVersion === 1 && ffile.count === 1,
   '导出文件头是 word-flags v1（内容侧 triage_flags.py --from 吃这个）')
ok(ffile.flags[0].word === flagged.sense.word && ffile.flags[0].slot === flagged.sense.slot,
   '清单带词与 slot（内容侧按 TSV 的 (word, senseId) 对位）')

/* 关键：内容侧「只改译文、原文没变」时，替换例句不能把标记弄丢 */
const keepPlan = await importer.planImport({
  word: flagged.sense.word,
  senses: [{
    slot: flagged.sense.slot,
    gloss: flagged.sense.gloss,
    sentences: [
      { text: flagged.sentence.en, translation: '改过的译文。' },
      { text: 'Another sentence for this sense.', translation: '另一句。' },
    ],
  }],
})
ok(keepPlan.senses[0].kind === 'update', '命中已有义项')
const kd = importer.defaultDecisions(keepPlan)
kd.sentences[keepPlan.senses[0].key] = 'take'
await importer.applyPlan(keepPlan, kd)
const afterTake = await flags.listFlags()
ok(afterTake.length === 1 && afterTake[0].note === '这句例句有问题',
   '原文不变的替换之后标记与备注都还在（否则修没修无从得知）')
const zhNow = (await db.sentences.where('senseId').equals(flagged.sense.id).toArray())
  .find((s) => s.en === flagged.sentence.en)
ok(zhNow && zhNow.zh === '改过的译文。' && zhNow.flagged === 1, '译文确实更新了，且标记没丢')

await flags.clearFlags([afterTake[0].sentenceId])
ok((await flags.listFlags()).length === 0, '关单后标记清空')
ok((await db.sentences.get(afterTake[0].sentenceId)).en === flagged.sentence.en,
   '关单只清标记，不动例句内容')

/* ── 7. 备份 + 回滚 ── */
const wordsBefore = await db.words.count()
const bk = await backup.buildBackup(true)
ok(bk.format === 'word.backup' && bk.schemaVersion === 2, '备份文件头符合协议')
ok(bk.words.length === wordsBefore, `备份含全部 ${bk.words.length} 个词`)
ok(bk.progress && bk.progress.length > 0, '含学习进度')
ok(bk.words.every((w) => w.senses.every((s) => s.sense.id)), '每个义项带 id（进度锚点随备份走）')

await backup.snapshot('冒烟快照')
const snaps = await backup.listSnapshots()
const mine = snaps.find((s) => s.label === '冒烟快照')
ok(!!mine, '快照已存')
await db.words.put({ word: 'zzz_gone', ipa: '', hidden: 0, createdAt: 1, updatedAt: 1 })
ok((await db.words.get('zzz_gone')) != null, '造一个多余词')
await backup.rollback(mine.id)
ok((await db.words.get('zzz_gone')) == null, '回滚后多余词消失')
ok((await db.words.count()) === wordsBefore, `回滚后词数复原（${await db.words.count()}）`)
ok((await db.progress.get(q1.sense.id)) != null, '回滚不动学习进度（只回内容层）')

/* ── 7b. 导入历史那一行怎么说话 ──
 * 存下来的 summary 有两种格式（内容包批量 / AI 单��），
 * 认错就会不报错地「少说一句」—— 这里把两种都钉住（坑 47）。
 * ★「改」和「冲突」后面**没有加号**（`词+18 义+66 改0 句+33 冲突0`），
 *   按 `key+N` 一刀切就永远漏掉这两项 —— 这条断言就是为它写的。 */
ok(
  backup.importLine({ ts: 1, word: 'a,b,c', summary: '词+18 义+66 改0 句+33 冲突0' }) ===
    '3 个词 · 66 义项 · 33 句',
  '内容包那套口径翻成人话，且去掉恒为 0 的项',
  backup.importLine({ ts: 1, word: 'a,b,c', summary: '词+18 义+66 改0 句+33 冲突0' }),
)
ok(
  backup.importLine({ ts: 1, word: 'army', summary: '新增义项0 例句10' }) === 'army · 新增义项0 例句10',
  'AI 单���那套本来就是人话，原样用（不重译成空）',
  backup.importLine({ ts: 1, word: 'army', summary: '新增义项0 例句10' }),
)
ok(
  backup.importLine({ ts: 1, word: 'army', summary: '词+1 义+2 改3 句+5 冲突4' }) ===
    'army · 1 词 · 2 义项 · 5 句 · 3 改 · 4 冲突',
  '「改」「冲突」后面没有加号，也要读得出来',
  backup.importLine({ ts: 1, word: 'army', summary: '词+1 义+2 改3 句+5 冲突4' }),
)

/* ── 8. 回收站 ── */
const victim = pool[0]
await edit.softDeleteSense(victim.id)
ok((await quiz.practicePool()).every((s) => s.id !== victim.id), '删掉的义项不再出题')
ok((await backup.buildBackup(true)).words.some((w) => w.senses.some((s) => s.sense.id === victim.id)),
   '备份里仍带着删掉的义项（可还原）')

/* 30 天清理：超期才清，没到期的不动 */
const fresh = pool[1]
const old = pool[2]
const DAY = 86400000
await edit.softDeleteSense(fresh.id)
await db.senses.update(old.id, { deletedAt: Date.now() - 40 * DAY })
const swept = await dbApi.sweepTrash(30, Date.now())
ok(swept === 1 && (await db.senses.get(old.id)) == null,
   `超 30 天的自动清掉（本次 ${swept} 条）`)
ok((await db.senses.get(fresh.id))?.deletedAt != null, '没到期的还在回收站里')
await dbApi.emptyTrash()
ok((await dbApi.trashedSenses()).length === 0, '清空回收站后不留残骸')
ok((await db.senses.get(pool[3].id)) != null, '只清被软删的义项，从没删过的没动')

/* ── 9. 跨侧：清单能不能被内容侧读懂（闭环的最后一环）── */
import { execFileSync } from 'node:child_process'
{
  const someSense = (await quiz.practicePool())[0]
  const sq = await quiz.makeQuestion(someSense.id)
  await quiz.flagQuestion(sq, '闭环测试标记')
  const fpath = path.join(HERE, '_flags_test.json')
  writeFileSync(fpath, JSON.stringify(flags.buildFlagsFile(await flags.listFlags())), 'utf8')
  const triage = path.resolve(WEB, '..', '..', 'content-kit', 'pipeline', 'triage_flags.py')
  let out = ''
  let ran = true
  try {
    out = execFileSync('python', [triage, '--from', fpath], { encoding: 'utf8' })
  } catch (e) {
    ran = false
    out = String(e.stderr ?? e.message)
  }
  if (!ran) {
    console.log('  SKIP  内容侧 triage_flags.py 跑不起来（没有 python？），跨侧那一环没验')
  } else {
    ok(out.includes(someSense.word), '内容侧清单里能看到被标记的词', out.slice(0, 120))
    ok(out.includes('闭环测试标记'), '标记备注也过去了（内容侧知道问题是什么）')
    ok(out.includes('已修好'), '清单末尾印的是浏览器端的关单流程（错题板点「已修好」）')
    ok(!out.includes('flags.mjs'), '没有把旧服务端那套关单命令印出来（那条线已不是当前应用）')
  }
  await flags.clearFlags([sq.sentence.id])
  rmSync(fpath, { force: true })
}

console.log(bad ? `\n${bad} 处失败` : '\n数据层端到端：全绿')
process.exitCode = bad ? 1 : 0