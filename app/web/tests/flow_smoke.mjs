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
const { edit, importer, backup, quiz, bundleImport, flags, lookup, ai, nav, spell, marks, parse } = M

let bad = 0
function ok(cond, msg, detail = '') {
  if (cond) console.log(`  PASS  ${msg}`)
  else {
    bad++
    console.log(`  FAIL  ${msg}${detail ? '  → ' + detail : ''}`)
  }
}

/* ── 1. 种子导入（word-bundle 内容包 → IndexedDB）── */
const seed = JSON.parse(readFileSync(path.join(WEB, 'public', 'seed.json'), 'utf8'))
const rep = await bundleImport.importBundle(seed)
ok(rep.errors.length === 0, `种子导入无错误（${rep.errors[0] ?? ''}）`)
ok(rep.wordsAdded === seed.stats.words, `词数 ${rep.wordsAdded} = ${seed.stats.words}`)
ok(rep.sensesAdded === seed.stats.senses, `义项数 ${rep.sensesAdded} = ${seed.stats.senses}`)
ok(rep.sentencesAdded === seed.stats.sentences, `例句数 ${rep.sentencesAdded} = ${seed.stats.sentences}`)
{
  const health = M.sentenceHealth
  const counts = health.usableSentenceCounts([
    { senseId: 'a', flagged: 0 },
    { senseId: 'a', flagged: 1 },
    { senseId: 'a', flagged: 0 },
    { senseId: 'b', flagged: 0 },
  ])
  ok(health.MIN_SENTENCES_PER_SENSE === 2, '例句健康线是 2 句（1 句和 0 句都算不足）')
  ok(counts.get('a') === 2 && counts.get('b') === 1,
     '可练例句计数跳过 flagged 句，单句义项能被识别')
  ok(health.hasTooFewSentences(0) && health.hasTooFewSentences(1) && !health.hasTooFewSentences(2),
     '0/1 句判为不足，2 句通过')
}
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

/* ── 2b. 多词形高亮：marks 协议 ── */
{
  const both = marks.locateMarks('Climate changes; the climate changed.', 'climate')
  ok(both.length === 2 && both[0].form === 'Climate' && both[1].form === 'climate',
     '同一词形出现多次都会标出来，且保留原句大小写')
  ok(marks.locateMarks('ago go go.', 'go').length === 2, '整词边界生效：ago 里的 go 不算')

  const multi = marks.marksFromForms('He went, then goes; going.', ['went', 'goes', 'going', 'go'])
  ok(multi.length === 3 && multi.map((m) => m.form).join('|') === 'went|goes|going',
     '多个不同词形落成多个区间，按位置排序')
  const overlap = marks.marksFromForms('going', ['go', 'going'])
  ok(overlap.length === 1 && overlap[0].form === 'going', '重叠区间保留更长的那个')

  const fixed = marks.normalizeMarks('A went home.', [{ start: 99, len: 4, form: 'went' }])
  ok(fixed.length === 1 && fixed[0].start === 2 && fixed[0].form === 'went',
     '坏区间会按 form 重新定位，不把高亮打偏')
  const legacy = marks.marksOfSentence({ en: 'A went home.', form: 'went', spanStart: 2, spanLen: 4 })
  ok(legacy.length === 1 && legacy[0].start === 2, '旧 span 数据仍能读出高亮')
  const mirrored = marks.legacySpanOf(multi)
  ok(mirrored.spanStart === multi[0].start && mirrored.spanLen === multi[0].len &&
     mirrored.form === multi[0].form, 'marks[0] 会镜像到旧 span 字段')
  ok(marks.formsOfSentence({ en: 'He went, then goes; going.', marks: multi }).join('|') === 'went|goes|going',
     'formsOfSentence 给出去重后的小写词形')

  await edit.purgeWord('zzmarkprobe')
  const probe = await edit.addWord('zzmarkprobe')
  const probeEn = 'Zzmarkprobe met zzmarkprobe and zzmarkprobed.'
  const probeMarks = marks.marksFromForms(probeEn, ['zzmarkprobe', 'zzmarkprobed'])
  await edit.addSentence(probe.senseId, probe.word, probeEn, '探针句', probeMarks)
  let row = await db.sentences.where('senseId').equals(probe.senseId).first()
  ok(row?.marks?.length === 3 && row.spanStart === 0 && row.form === 'Zzmarkprobe',
     '新例句落库时保留全部 marks，并镜像第一条旧 span', JSON.stringify(row?.marks))

  const rewritten = await edit.replaceSentence(row.id, 'Zzmarkprobe and zzmarkprobed returned.')
  ok(rewritten?.marks?.length === 2 && rewritten.marks[1].form === 'zzmarkprobed',
     '手改英文后按旧词形重新定位，高亮不沿用旧区间')
  const lost = await edit.replaceSentence(row.id, 'Nothing relevant here.')
  ok(lost?.marks === undefined && lost?.spanStart === -1,
     '新句找不到目标词时清掉 marks，而不是保留错误高亮')
  await edit.purgeWord(probe.word)
  ok((await db.words.get(probe.word)) == null, '高亮探针词已清干净')

  await edit.purgeWord('zzmarkimport')
  const imported = await bundleImport.importBundle({
    format: 'word-bundle',
    cards: [{
      word: 'zzmarkimport',
      slot: 1,
      gloss: '导入探针',
      sentences: [{
        text: 'He zzmarkimported it.',
        highlights: ['zzmarkimported'],
        translation: '他导入了它。',
      }],
    }],
  })
  const importedSense = await db.senses.where('word').equals('zzmarkimport').first()
  const importedRow = importedSense
    ? await db.sentences.where('senseId').equals(importedSense.id).first()
    : undefined
  ok(imported.errors.length === 0 && imported.sentencesAdded === 1 && importedRow?.marks?.length === 1,
     '导入协议的 highlights 会落成 marks', JSON.stringify(imported.errors))
  ok(importedRow?.spanStart === 3 && importedRow?.form === 'zzmarkimported',
     '导入时同步镜像旧 span')
  await edit.purgeWord('zzmarkimport')
  ok((await db.words.get('zzmarkimport')) == null, '导入高亮探针词已清干净')

  const bind = {
    word: 'go',
    ipa: '',
    senses: [{ id: 's-go', slot: 1, word: 'go', gloss: '去' }],
    sentences: [],
  }
  const parsed = parse.parseProposals(JSON.stringify({
    proposals: [{
      kind: 'sentence.add',
      slot: 1,
      en: 'He went home and goes out.',
      zh: '他回家又出门。',
      highlights: ['went', 'goes'],
    }],
  }), bind)
  ok(parsed.proposals.length === 1 && parsed.proposals[0].marks?.length === 2 &&
     parsed.proposals[0].marks[0].form === 'went' &&
     parsed.proposals[0].marks[1].form === 'goes',
     'AI highlights 落成多个 marks，不规则词形也能高亮')
  const rejected = parse.parseProposals(JSON.stringify({
    proposals: [{
      kind: 'sentence.add',
      slot: 1,
      en: 'Nothing relevant here.',
      highlights: ['went'],
    }],
  }), bind)
  ok(rejected.proposals.length === 0 && rejected.dropped.length === 1,
     '声明了 highlights 但一个都对不上时丢句，不静默接受')
}

/* ── 3. 编辑义项：id 永不变 ── */
const bank = await db.senses.where('word').equals('bank').first()
const before = await db.senses.where('word').equals('bank').toArray()
const maxSlot = Math.max(...before.map((s) => s.slot))
const newId = await edit.addSense('bank', '临时意思')
const bankAfter = await db.senses.where('word').equals('bank').toArray()
ok(bankAfter.some((s) => s.id === bank.id && s.slot === bank.slot),
   '新增义项不改动已有义项的 id 与 slot')
ok(bankAfter.length === before.length + 1, '义项数 +1')

await edit.updateSense(newId, { gloss: '改过的意思', pos: 'n.' })
ok((await db.senses.get(newId)).gloss === '改过的意思', '就地编辑落库')

/* slot 重排后 id 不变 */
await dbApi.reorderSenses('bank', [...bankAfter].reverse())
const bankReordered = await db.senses.where('word').equals('bank').toArray()
const sameIds = new Set(before.map((s) => s.id))
ok(bankReordered.filter((s) => sameIds.has(s.id)).every((s) => s.slot !== undefined),
   '重排后老义项仍在（进度锚点没丢）')
ok((await db.progress.get(bank.id)) != null, '重排不影响挂在 id 上的进度行')

/* ── 4. 合并：例句与熟练度都并过去 ── */
const withSents = (await db.senses.where('word').equals('bank').toArray())
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
  word: 'bank',
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
const badPlan = await importer.planImport({ word: 'bank', senses: [{ slot: 1, gloss: '' }] })
ok(badPlan.errors.length > 0 && badPlan.senses.length === 0, 'gloss 为空 → 整份拒绝')

const glossBefore = (await db.senses.get(a1.id)).gloss
const msg = await importer.applyPlan(plan, d)
ok((await db.senses.get(a1.id)).gloss === glossBefore, '按默认决策写入后，本地释义没被覆盖')
ok((await db.senses.where('word').equals('bank').toArray()).some((s) => s.gloss === '本地没有的意思'),
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

/* 6.05 防连续重复：同一个义项有 2 句时，作答后下一题必须换另一句 */
{
  const W = 'zzzrotate'
  const { senseId } = await edit.addWord(W)
  await edit.updateSense(senseId, { gloss: '轮换测试', pos: 'n.' })
  await edit.addSentence(senseId, W, `The first ${W} is here.`)
  await edit.addSentence(senseId, W, `The second ${W} is there.`)
  const seen = []
  for (let i = 0; i < 5; i++) {
    const q = await quiz.makeQuestion(senseId)
    seen.push(q.sentence.id)
    await quiz.recordAnswer(q, quiz.newSessionId(), i, 'CORRECT', 500)
  }
  ok(seen.every((id, i) => i === 0 || id !== seen[i - 1]),
     '同一义项连续两题不会出同一句', seen.join(','))
  ok(new Set(seen).size === 2, '两句交替出现，没有丢掉任何一句')
  ok((await db.progress.get(senseId)).lastSentenceId === seen[seen.length - 1],
     '作答后记住上一句（下次出题据此避让）')
  const pinned = await quiz.makeQuestion(senseId, seen[0])
  ok(pinned.sentence.id === seen[0], '显式钉住某句时仍然优先用它（回看不被避让逻辑改题）')
  await edit.purgeWord(W)
}

/* ── 6.1 问题句闭环：标记 → 导出 → 关单 ── */
const flagRows = await flags.listFlags()
ok(flagRows.length === 1 && flagRows[0].sentence === flagged.sentence.en,
   '标记出现在清单里，带上词/义项/原文')
ok(flagRows[0].note === '这句例句有问题', '标记备注带出去了（内容侧要知道问题是什么）')
const ffile = flags.buildFlagsFile(flagRows, 1758000000000)
ok(ffile.format === 'word-flags' && ffile.schemaVersion === 1 && ffile.count === 1,
   '导出文件头是 word-flags v1（可交接的待修清单格式）')
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

/* ── 6.2 选项规则与「当场改」的写入语义（D36）──
 * 这两件事守卫（verify_docs）只能判源码形状：它判得了「buildOptions 里写着
 * 同词性过滤」，判不了「选项真的全是同一个词性」。而这两条规则一旦退化，
 * 界面上**什么都不报**：点开题目一切正常，只是「又能靠词性蒙对了」、
 * 或者「同词的干扰项再也不出现了」。所以这里用自己造的数据把它们钉住。
 *
 * 数据是自己造的，所以断言必须是确定的（坑 28）：不依赖随机数、也不依赖
 * 种子词库里恰好有哪个词 —— 造三个同词性义项，就能把「同词性」和
 * 「同词优先」两条同时判死。 */
{
  const W = 'zzzprobe'
  const { senseId: s1 } = await edit.addWord(W, '/zzz/')
  const s2 = await edit.addSense(W, '')
  const s3 = await edit.addSense(W, '')
  await edit.updateSense(s1, { gloss: '甲义（名词）', pos: 'n.' })
  await edit.updateSense(s2, { gloss: '乙义（名词）', pos: 'n.' })
  await edit.updateSense(s3, { gloss: '丙义（名词）', pos: 'n.' })
  await edit.addSentence(s1, W, `I saw a ${W} on the table.`)
  await edit.addSentence(s2, W, `The ${W} broke in half.`)
  await edit.addSentence(s3, W, `Another ${W} stood by the door.`)

  const q = await quiz.makeQuestion(s1)
  ok(q != null && q.options.length === 4, '自己造的词也能出满 4 个选项')
  ok(q.options.includes('甲义（名词）'), '正解在选项里')
  // 同词的两个义项先占掉两个干扰位（D36 第四节）
  ok(q.options.includes('乙义（名词）') && q.options.includes('丙义（名词）'),
     '同一个词的其它义项占掉两个干扰位（同词优先）')

  const glossToPos = new Map()
  for (const s of await db.senses.filter((x) => x.deletedAt == null).toArray()) {
    glossToPos.set(s.gloss, s.pos)
  }
  const wrong = q.options.filter((g) => g !== '甲义（名词）')
  ok(wrong.length === 3, `三个干扰项 + 一个正解（实际 ${q.options.length} 个）`)
  ok(wrong.every((g) => glossToPos.get(g) === 'n.'),
     '干扰项全部与正解同词性（不能靠词性排除蒙对）',
     wrong.map((g) => `${g}=${glossToPos.get(g)}`).join(' '))

  // 兜底：该词性只有它自己一个来源时，宁可词性不齐也要凑满四个
  const R = 'zzzrare'
  const { senseId: r1 } = await edit.addWord(R, '/rrr/')
  await edit.updateSense(r1, { gloss: '罕见词性义项', pos: 'zzz.' })
  await edit.addSentence(r1, R, `A ${R} appeared once.`)
  const qr = await quiz.makeQuestion(r1)
  ok(qr != null && qr.options.length === 4, '同词性凑不满时仍凑满 4 个（兜底不死锁）')
  ok(qr.options.includes('罕见词性义项'), '兜底时正解仍在')

  // 「当场改」的写入语义：只提交动过的字段，别的字段不许被顺手清空
  const rSent = (await db.sentences.where('senseId').equals(r1).toArray())[0]
  const enBefore = rSent.en
  await edit.updateSentence(rSent.id, { zh: '只改中文' })
  const rAfter = await db.sentences.get(rSent.id)
  ok(rAfter.zh === '只改中文' && rAfter.en === enBefore,
     '只改中文不会把英文清空（QuickEdit 只提交动过的字段）')
  await edit.updateSense(r1, { gloss: '改过的释义' })
  const rSense = await db.senses.get(r1)
  ok(rSense.gloss === '改过的释义' && rSense.pos === 'zzz.',
     '只改释义不会丢掉词性（同理）')

  // 清掉探针词，免得污染后面的计数
  await edit.purgeWord(W)
  await edit.purgeWord(R)
  ok((await db.words.get(W)) == null && (await db.words.get(R)) == null,
     '造出来的探针词已清干净（不留残骸）')
}

/* ── 6.3 点词查义：形态还原、命中、未入库加入（D36 的延伸）──
 * 这一组守的是「答完之后句子里任何一个词都查得到」这条体验：
 * 句子里的词是**屈折形式**（ordered / sides / studies），词库存的是原形。
 * 只按 `db.words.get(token)` 查会大面积落空，而落空在界面上长得像
 * 「词库里没这个词」—— 用户会以为词库缺词。 */
{
  // 纯函数：候选顺序错了，就会把人带到不存在的词上
  const seq = (w) => lookup.guessLemmas(w)
  ok(seq('ordered')[1] === 'order', 'ordered → order（去掉 ed，第一个派生候选）', seq('ordered').join(','))
  ok(seq('sides')[1] === 'side', 'sides → side（先只去一个 s）', seq('sides').join(','))
  ok(seq('studies')[1] === 'study', 'studies → study（ies → y）', seq('studies').join(','))
  ok(seq('stopped').includes('stop'), 'stopped → stop（去双写）', seq('stopped').join(','))
  ok(seq('making').includes('make'), 'making → make（补 e）', seq('making').join(','))
  ok(seq('boxes')[1] === 'box', 'boxes → box（去 es；以 x 结尾先试去 es）', seq('boxes').join(','))
  ok(seq('Bank,')[0] === 'bank', '大小写与标点先规范化', seq('Bank,').join(','))

  // 命中：原形直接查得到
  const p1 = await lookup.peekWord('bank')
  ok(p1.exact && p1.word?.word === 'bank' && p1.senses.length > 0,
     `库里有的词直接命中（${p1.senses.length} 个义项）`)
  ok(p1.senses.every((s) => s.word === 'bank'), '只给这个词自己的义项，不混别的词')
  ok(p1.senses.every((s) => p1.sentenceCounts.has(s.id)),
     '每个义项都带例句条数（浮层要让人知道点进去有没有东西看）')

  // 命中：屈折形式落到原形（banks → bank）
  const p2 = await lookup.peekWord('banks')
  ok(!p2.exact && p2.word?.word === 'bank', 'banks 命中原形 bank（exact=false）')
  ok(p2.lemma === 'bank' && p2.token === 'banks', '浮层要能说清「句子里的是 X、原形是 Y」')

  // 未入库：不假装命中，也不把规则候选当原形
  const p3 = await lookup.peekWord('blorping')
  ok(!p3.word && p3.senses.length === 0, '库里没有的词不会假装命中')
  ok(p3.lemma === 'blorping', `未入库时保留原词形，不猜 blorp（${p3.lemma}）`)
  ok(p3.stop === false, '普通生词不是虚词，应该给「加入词库」入口')

  // 回归：minister 不是 minist 的变形；规则候选不得被当成原形
  const minister = await lookup.peekWord('minister')
  ok(minister.lemma === 'minister',
     `minister 不能被 er 规则剥成 minist（${minister.lemma}）`)

  // 虚词不给加入入口（否则词库里会多出 the / of 这种垃圾）
  ok((await lookup.peekWord('the')).stop === true, '虚词被识别出来（不提供加入）')

  // 加入词库：建词条 + 占位义项，且**必须标 needsRefine**
  const add1 = await edit.addPendingWord('blorp')
  ok(add1.existed === false && add1.word === 'blorp', '加入词库建出了词条')
  const added = await db.senses.get(add1.senseId)
  ok(added?.needsRefine === 1 && added.gloss === '',
     '占位义项标了「需精修」、释义为空（空壳不能静默混进复习池）')
  ok((await lookup.peekWord('blorp')).word?.word === 'blorp', '加入之后立刻查得到')
  const add2 = await edit.addPendingWord('blorp')
  ok(add2.existed === true && add2.senseId === add1.senseId, '重复加入不建第二个词条/义项')
  await edit.purgeWord('blorp')
  ok((await db.words.get('blorp')) == null, '探针词已清干净')
}

/* ── 6.4 AI 全链路（假传输）：配置门禁 → 请求 → 解析 → 缓存 → 应用 ──
 * ★ 为什么这里能测 AI：传输层是注入的（`__setTransportForTest`），
 *   所以整条链路（拼提示词 → 发请求 → 解析 → 校验 → 提案 → 应用）都在
 *   Node 里真跑，只有「字节怎么出门」被换成假的。
 *
 * ★ 重点验三件**容易静默坏掉**的事：
 *   1. 没配 key 时必须报「没配置」，而不是发一个空 Bearer 出去；
 *   2. AI 的幻觉必须被挡住（不存在的 slot、句子里没有目标词）；
 *   3. 内容没变时第二次调用必须走缓存（省钱这条要能被证明）。
 */
{
  const W = 'zzzai'
  const { senseId } = await edit.addWord(W)
  await edit.updateSense(senseId, { gloss: '原释义', pos: 'n.' })
  await edit.addSentence(senseId, W, `A ${W} stood here.`)
  const sid1 = (await db.sentences.where('senseId').equals(senseId).toArray())[0].id

  // 1) 没配置 → 明确报 no-config（不是发出去再失败）
  let noCfg = null
  try {
    await ai.reviewWord(W)
  } catch (e) {
    noCfg = e
  }
  ok(noCfg && noCfg.kind === 'no-config', '没配 key 时直接报「没配置」，不发请求')

  // 2) 注入假传输：记录请求，返回一段包含幻觉的 JSON
  let calls = 0
  let lastBody = null
  let lastUrl = ''
  let lastAuth = ''
  const fake = {
    name: 'fake',
    async postJson(url, headers, body /*, timeoutMs */) {
      calls++
      lastUrl = url
      lastAuth = headers.Authorization ?? ''
      lastBody = JSON.parse(body)
      const canned = {
        note: '看了一下，有 3 处',
        proposals: [
          { kind: 'sense.update', slot: 1, gloss: 'AI 修的释义', pos: 'n.', trap: 1, why: '更准确，且这是熟词僻义' },
          { kind: 'word.update', ipa: 'ˈziːzi', why: '原来那个不像音标' },
          { kind: 'sentence.add', slot: 1, en: `The ${W} stood on the hill.`, zh: '它站在山上。', why: '补一句' },
          { kind: 'sentence.replace', sentenceId: sid1, en: `A ${W} appeared near the river.`, zh: '它出现在河边。', why: '换一句' },
          // 幻觉一号：句子里根本没有目标词
          { kind: 'sentence.add', slot: 1, en: 'Nothing to see here.', zh: '这里什么都没有。', why: '不含目标词' },
          // 幻觉二号：不存在的槽位
          { kind: 'sense.update', slot: 9, gloss: '不存在的意思' },
          // 噪音：与上一条音标完全重复（重复的提案不该占两行）
          { kind: 'word.update', ipa: '/ˈziːzi/' },
        ],
      }
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify(canned) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      }
    },
  }
  ai.__setTransportForTest(fake)
  ai.__setConfigForTest({
    enabled: true,
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    maxTokens: 800,
    temperature: 0.2,
  })

  const r = await ai.reviewWord(W)
  ok(calls === 1, '一次审查只发一次请求（不是每个义项一次）')
  ok(lastUrl === 'https://example.test/v1/chat/completions', '端点拼对了（baseUrl 会自动补 /chat/completions）', lastUrl)
  ok(lastAuth === 'Bearer sk-test', 'Authorization 头带上了 key')
  ok(lastBody?.model === 'test-model' && lastBody?.max_tokens === 800, '模型与输出上限来自配置')
  ok(lastBody?.response_format?.type === 'json_object', '要求 JSON 输出（省掉一半解析麻烦）')
  ok(r.proposals.length === 4, `幻觉与噪音被挡掉，只剩 4 条可用（实际 ${r.proposals.length}）`)
  ok(r.proposals.some((p) => p.kind === 'word.update' && p.ipa === 'ˈziːzi'),
     '音标提议（去掉两边的斜杠，跟 Word.ipa 同格式）')
  ok(r.usage?.total === 150, '带回了 token 用量（界面要显示这次花了多少）')
  ok(r.note.includes('不可用'), '被丢掉的建议有交代，不是静默消失', r.note)
  ok(r.cached === false, '首次是真调用')

  // 3) 内容没变 → 第二次必须命中缓存（省钱这条要能被证明）
  const r2 = await ai.reviewWord(W)
  ok(r2.cached === true && calls === 1, '同样内容第二次调用走缓存，没有再花钱')
  ok(r2.proposals.length === 4, '缓存回来的提案一样可用')

  // 4) 应用：改释义 + 补音标 + 补一句 + 换一句（换句要重算高亮区间）
  const { applied } = await ai.applyAll(r.proposals)
  ok(applied === 4, `四条都应用了（${applied}）`)
  const senseNow = await db.senses.get(senseId)
  ok(senseNow.gloss === 'AI 修的释义' && senseNow.pos === 'n.', '释义改对了，词性没被顺手清掉')
  ok(senseNow.trap === 1, '熟词僻义标记落库了（它会改新卡的起始间隔，所以必须能看见、能应用）')
  ok((await db.words.get(W)).ipa === 'ˈziːzi', '音标落到了词条上（不是义项）')

  // 4b) 已有音标时**不许再改**：模型判断“音标对不对”不可靠，
  //     真机上它把一个对的 /ˈæspɛkt/ 改成了丢掉重音的 /æspekt/。
  const r3 = await ai.reviewWord(W)   // 内容变了 → 新的一次调用
  ok(r3.cached === false && r3.proposals.every((p) => p.kind !== 'word.update'),
     '已有音标的词不再接受音标改写（只补缺）', r3.note)
  const sentsNow = await db.sentences.where('senseId').equals(senseId).toArray()
  ok(sentsNow.length === 2, `两句（原来 1 句 + 补 1 句，替换不新增）实际 ${sentsNow.length}`)
  const replaced = sentsNow.find((s) => s.id === sid1)
  ok(replaced?.en === `A ${W} appeared near the river.`, '被替换的句子换成新内容')
  ok(replaced?.zh === '它出现在河边。', '替换时中文也跟着换')
  ok(replaced?.form === W && replaced.spanStart >= 0 &&
     replaced.en.slice(replaced.spanStart, replaced.spanStart + replaced.spanLen) === W,
     '替换后重新定位了目标词区间（高亮不会打偏）')
  ok((await db.snapshots.count()) > 0, '应用前自动存了快照（AI 一次改多条，人可以整批退回）')

  // 5) 「换一句」单个动作
  ai.__setTransportForTest({
    name: 'fake2',
    async postJson() {
      calls++
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: 'ok',
            proposals: [{ kind: 'sentence.replace', sentenceId: sid1, en: `Every ${W} has a name.`, zh: '每个都有名字。' }],
          }) } }],
        }),
      }
    },
  })
  const rRep = await ai.replaceSentence(sid1, '原句不自然')
  ok(rRep.proposals.length === 1 && rRep.proposals[0].kind === 'sentence.replace', '换一句只产出一条替换提议')
  await ai.applyAll(rRep.proposals)
  ok((await db.sentences.get(sid1)).en === `Every ${W} has a name.`, '换一句落库了')

  // 5b) 义项审查：目标义项的例句必须**全带上**，并且能一次换多句
  await edit.addSentence(senseId, W, `The ${W} waited by the third door.`)
  const sid3 = (await db.sentences.where('senseId').equals(senseId).toArray())
    .find((s) => s.en.includes('third door')).id
  let addBody = null
  ai.__setTransportForTest({
    name: 'fake-add',
    async postJson(_url, _headers, body) {
      calls++
      addBody = JSON.parse(body)
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: 'ok',
            proposals: [{ kind: 'sentence.add', slot: 1, en: `A new ${W} appeared.`, zh: '又一句。', highlights: [W] }],
          }) } }],
        }),
      }
    },
  })
  await ai.addSentence(senseId, 1)
  const addMsg = addBody?.messages?.[1]?.content ?? ''
  ok(addMsg.includes('当前义项') && addMsg.includes('third door'),
     '补例句也带全当前义项的全部例句（不只前两句）')
  ok(addMsg.includes('不要退回更常见的意思'),
     '默认补例句提示词要求锁定当前义项')

  let senseBody = null
  ai.__setTransportForTest({
    name: 'fake3',
    async postJson(_url, _headers, body) {
      calls++
      senseBody = JSON.parse(body)
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: '三句都犯了同一个错',
            proposals: [
              { kind: 'sentence.replace', sentenceId: sid1, en: `A fresh ${W} sat by the river.`, zh: '一句新的。', highlights: [W] },
              { kind: 'sentence.replace', sentenceId: sid3, en: `Another ${W} sat by the window.`, zh: '又一句新的。', highlights: [W] },
            ],
          }) } }],
        }),
      }
    },
  })
  const rSense = await ai.reviewSense(senseId, '这几句都在用同一个错义，全部换掉')
  const senseMsg = senseBody?.messages?.[1]?.content ?? ''
  ok(senseMsg.includes(`The ${W} waited by the third door.`),
     '义项审查带上了第 3 句（以前只带前两句，AI 看不到它）')
  ok(senseMsg.includes('当前义项') && senseMsg.includes('其它义项（只给释义'),
     '义项审查明确标出「当前义项」，并把其它义项隔开（防止串义）')
  ok(senseMsg.includes('全部换掉'), '用户补充要求进了提示词')
  ok(rSense.action === 'reviewSense' && rSense.proposals.length === 2,
     '义项审查可以一次返回多条替换提议')
  await ai.applyAll(rSense.proposals)
  ok((await db.sentences.get(sid3)).en === `Another ${W} sat by the window.`,
     '同一个错误模式出现在多句时，第 3 句也能被一次换掉')

  // 5c) 换第 3 句时，目标句本身必须在上下文里（否则 AI 只能猜）
  const sid3Text = (await db.sentences.get(sid3)).en
  let replaceBody = null
  ai.__setTransportForTest({
    name: 'fake4',
    async postJson(_url, _headers, body) {
      calls++
      replaceBody = JSON.parse(body)
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: 'ok',
            proposals: [{ kind: 'sentence.replace', sentenceId: sid3, en: `One more ${W} appeared.`, zh: '又来一句。', highlights: [W] }],
          }) } }],
        }),
      }
    },
  })
  await ai.replaceSentence(sid3, '这句不自然')
  const replaceMsg = replaceBody?.messages?.[1]?.content ?? ''
  ok(replaceMsg.includes(sid3Text), '换第 3 句时目标句在上下文里，不再让 AI 盲猜')
  ok(replaceMsg.includes('← 这次要处理的就是这句'), '目标句在上下文里被明确标出来')
  ok(replaceMsg.includes('不能切到该词的其它义项') && replaceMsg.includes('不要退回更常见的意思'),
     '默认换句提示词要求锁定当前义项，不能退回常见义项')

  // 6) 内容一改，缓存必须失效（否则会拿旧建议改新内容）
  const beforeCalls = calls
  await edit.updateSense(senseId, { gloss: '又改了一次' })
  await ai.reviewWord(W)
  ok(calls > beforeCalls, '内容变了就不再用旧缓存（重新问一次）')

  // 7) 空壳词「AI 补全」：每个义项都必须带例句；占位义项用 update，新义项用 add
  const F = 'zzzfill'
  const pend = await edit.addPendingWord(F)
  ok((await db.senses.get(pend.senseId)).gloss === '', '先有一个空壳词条（占位义项）')
  ai.__setTransportForTest({
    name: 'fake3',
    async postJson() {
      calls++
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: '补好了',
            proposals: [
              {
                kind: 'sense.update',
                slot: 1,
                gloss: '填充出来的释义',
                pos: 'n.',
                why: '占位义项',
                sentences: [
                  { en: `This ${F} is useful.`, zh: '这个填充词很有用。' },
                  { en: `We need a ${F} here.`, zh: '我们这里需要一个填充词。' },
                ],
              },
              {
                kind: 'sense.add',
                gloss: '第二个意思',
                pos: 'v.',
                why: '常用义项',
                sentences: [
                  { en: 'Nothing relevant here.', zh: '不含目标词，应被丢弃' },
                  { en: `They ${F} the box every day.`, zh: '他们每天这样处理箱子。' },
                  { en: `She will ${F} the plan tomorrow.`, zh: '她明天会调整计划。' },
                ],
              },
            ],
          }) } }],
        }),
      }
    },
  })
  const rf = await ai.fillWord(F, 3)
  ok(rf.action === 'fillWord', '动作标记是 fillWord（界面据此换标题）')
  ok(rf.proposals.length === 2, `两条提案：改占位义项 + 新增义项（实际 ${rf.proposals.length}）`)
  const updProp = rf.proposals.find((p) => p.kind === 'sense.update')
  ok(updProp?.sentences?.length === 2, '占位义项也带上了 2 句例句')
  const addedProp = rf.proposals.find((p) => p.kind === 'sense.add')
  ok(addedProp?.sentences?.length === 2, '新义项保留 2 句含目标词的例句（幻觉句被丢）')
  ok(rf.note.includes('不可用'), '丢掉的句子有交代', rf.note)

  await ai.applyAll(rf.proposals)
  const s1After = await db.senses.get(pend.senseId)
  ok(s1After.gloss === '填充出来的释义' && s1After.needsRefine === 0,
     '占位义项被改写，且「需精修」标记跟着摘掉（补完就不该再挂在待办里）')
  ok((await db.sentences.where('senseId').equals(pend.senseId).toArray()).length === 2,
     'update 提案里带的例句也跟着占位义项落库')
  const filled = (await db.senses.where('word').equals(F).toArray()).find((s) => s.gloss === '第二个意思')
  ok(!!filled, '新义项建出来了')
  const fSents = await db.sentences.where('senseId').equals(filled.id).toArray()
  ok(fSents.length === 2, '新义项的 2 句例句一起落库（没有 id/slot 时只能这么提）')
  ok(fSents[0].form === F && fSents[0].spanStart >= 0, '落库时算好了高亮区间')

  // 7b) 「新词 + 补音标」在同一批里：词条还不存在时音标不能被 update 的静默 no-op 吞掉
  const N = 'zzznew'
  ai.__setTransportForTest({
    name: 'fake4',
    async postJson() {
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: 'ok',
            proposals: [
              { kind: 'word.update', ipa: 'ˈnjuː', why: '缺音标' },
              { kind: 'sense.add', gloss: '新的意思', pos: 'adj.', why: '常用义项', sentences: [{ en: `A ${N} idea.`, zh: '一个新想法。' }, { en: `This ${N} plan works.`, zh: '这个新计划行得通。' }] },
            ],
          }) } }],
        }),
      }
    },
  })
  const rn = await ai.fillWord(N, 2)
  await ai.applyAll(rn.proposals)
  const newWord = await db.words.get(N)
  ok(newWord != null && newWord.ipa === 'ˈnjuː',
     '同批里的音标没有丢（词条不存在时 updateWord 要建出来，不能是空操作）',
     newWord ? newWord.ipa : 'no word')
  await edit.purgeWord(N)

  // 7c) 任一义项缺例句 → 整份拒绝，不写入（“要么都补，要么都不补”）
  const B = 'zzzbad'
  const badPend = await edit.addPendingWord(B)
  ai.__setTransportForTest({
    name: 'fake5',
    async postJson() {
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            note: '补了一半',
            proposals: [
              {
                kind: 'sense.update',
                slot: 1,
                gloss: '只配一句',
                sentences: [{ en: `A ${B} thing.`, zh: '一个坏例子。' }],
              },
              {
                kind: 'sense.add',
                gloss: '另一个意思',
                sentences: [
                  { en: `Another ${B} thing.`, zh: '另一个。' },
                  { en: `The ${B} works.`, zh: '这个能用。' },
                ],
              },
            ],
          }) } }],
        }),
      }
    },
  })
  let partial = null
  try {
    await ai.fillWord(B, 3)
  } catch (e) {
    partial = e
  }
  ok(partial?.kind === 'refused' && /至少要 2 句/.test(partial.message),
     '任一义项只有 1 句时整份拒绝，并说清最低句数', partial?.message)
  ok((await db.senses.get(badPend.senseId)).gloss === '',
     '被拒绝的补全不会改写占位义项（没有半成品落库）')
  ok((await db.sentences.where('senseId').equals(badPend.senseId).toArray()).length === 0,
     '被拒绝的补全不会写入任何例句')
  await edit.purgeWord(B)

  // 有释义的词不许再「补全」：那会重写已经有主的内容
  let refused = null
  try {
    await ai.fillWord(F, 3)
  } catch (e) {
    refused = e
  }
  ok(refused && refused.kind === 'refused', '已经有释义的词走「审查」，不走「补全」')

  // 8) 体检对象：先跑「最像有问题」的词（需精修 > 缺音标 > 例句少）
  const Z = 'zzzaudit'
  const pend2 = await edit.addPendingWord(Z)   // 需精修 + 无音标 + 占位义项
  ok(pend2.existed === false, '造一个需精修的空壳词')
  const tg = await ai.auditTargets()
  ok(tg.length > 0 && tg[0].word === Z, `需精修的词排在体检第一位（实际 ${tg[0]?.word}）`)
  ok(tg[0].refine === 1 && tg[0].hasIpa === false, '体检对象带上了「需精修 / 缺音标」这两个判据')
  ok(tg.every((t) => t.senses >= 1), '只把**有义项**的词列进体检（没义项的词没什么可审的）')
  await edit.purgeWord(Z)

  // 9) 体检预算预览：先算缓存命中，再说「还要几次请求」
  ai.__setConfigForTest({
    enabled: true,
    baseUrl: 'https://example.test',
    apiKey: 'sk-test',
    model: 'test-model',
    maxTokens: 800,
    temperature: 0.2,
  })
  const E = 'zzzest'
  const { senseId: eId } = await edit.addWord(E, '/e/')
  await edit.updateSense(eId, { gloss: '预算探针' })
  await edit.addSentence(eId, E, `A plain ${E} sentence here.`)
  const target = { word: E, senses: 1, sentences: 1, refine: 0, hasIpa: true }
  const est1 = await ai.auditEstimate([target])
  ok(est1.requests === 1 && est1.cached === 0,
     `没缓存时预览说「还要 1 次请求」（实际 ${est1.requests}/${est1.cached}）`)
  ok(est1.tokens > 0, `预览给出 token 量级（约 ${est1.tokens}）`)

  // 跑一次（假传输）→ 缓存命中 → 预览变「免费」
  ai.__setTransportForTest({
    name: 'fake-est',
    async postJson() {
      return {
        status: 200,
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ note: 'ok', proposals: [] }) } }] }),
      }
    },
  })
  await ai.reviewWord(E)
  const est2 = await ai.auditEstimate([target])
  ok(est2.requests === 0 && est2.cached === 1,
     `跑过之后预览说「已缓存」（实际 ${est2.requests}/${est2.cached}）`)
  ai.__setTransportForTest(null)
  await edit.purgeWord(E)

  // 10) 按学习状态组队列（词库页「练这组」走的就是它）
  const S = 'zzzscope'
  const { senseId: scopeId } = await edit.addWord(S, '/s/')
  await edit.updateSense(scopeId, { gloss: '作用域探针' })
  await edit.addSentence(scopeId, S, `A plain ${S} sentence.`)
  const nowS = Math.floor(Date.now() / 1000)

  ok((await quiz.buildScopeQueue('new', 50)).includes(scopeId), '没练过的词进「待学」队列')
  ok(!(await quiz.buildScopeQueue('learning', 50)).includes(scopeId), '没练过的不在「在学」里')

  await db.progress.put({
    senseId: scopeId, stability: 5, difficulty: 5, lastReview: nowS,
    dueAt: nowS + 86400, reps: 3, wrongN: 0, pendingN: 0, mastered: 0, rusty: 0,
  })
  ok((await quiz.buildScopeQueue('learning', 50)).includes(scopeId), '练过但没到期 → 「在学」')
  ok(!(await quiz.buildScopeQueue('due', 50)).includes(scopeId), '没到期 → 不在「今天到期」')

  await db.progress.update(scopeId, { dueAt: nowS - 10 })
  ok((await quiz.buildScopeQueue('due', 50)).includes(scopeId), '到期了 → 进「今天到期」')
  ok(!(await quiz.buildScopeQueue('new', 50)).includes(scopeId), '练过的词不再算「待学」')

  await edit.purgeWord(S)
  ok((await db.words.get(S)) == null, '队列探针词已清干净')

  // 11) 「排进明天练」：pin 的卡排在队首，且不改学习记录
  const P = 'zzzpin'
  const { senseId: pinId } = await edit.addWord(P, '/p/')
  await edit.updateSense(pinId, { gloss: '排期探针' })
  await edit.addSentence(pinId, P, `A plain ${P} sentence.`)
  // 先让它变成「练过、没到期」—— 正常情况下它**不会**进到期队列
  await db.progress.put({
    senseId: pinId, stability: 9, difficulty: 5, lastReview: nowS,
    dueAt: nowS + 30 * 86400, reps: 4, wrongN: 0, pendingN: 0, mastered: 0, rusty: 0,
  })
  ok(!(await quiz.buildQueue(50)).includes(pinId), '没到期、没 pin 时它不在队列里')

  await edit.pinSense(pinId, nowS - 1)   // 已到点（模拟「明天 0 点」已过）
  const q1 = await quiz.buildQueue(50)
  ok(q1[0] === pinId, `pin 的卡排在队首（实际第 ${q1.indexOf(pinId) + 1} 位）`)
  ok((await quiz.buildScopeQueue('due', 50))[0] === pinId, '它也出现在「今天到期」那一组的最前面')
  const pp = await db.progress.get(pinId)
  ok(pp.stability === 9 && pp.reps === 4, 'pin 不改学习记录（S/reps 原样）')

  await edit.unpinSense(pinId)
  ok(!(await quiz.buildQueue(50)).includes(pinId), '取消之后它又回到「还没到期就不出现」')
  ok((await db.progress.get(pinId)).pinAt === 0, '取消是置 0，不是删行')

  const tmr = edit.tomorrowStart()
  const d = new Date(tmr * 1000)
  ok(d.getHours() === 0 && d.getMinutes() === 0 && tmr * 1000 > Date.now(),
     '「明天」的口径是下一个 0 点（且在未来）')

  await edit.purgeWord(P)
  ok((await db.words.get(P)) == null, '排期探针词已清干净')

  // 12) 扫读卡：一张 3 句、目标词互不重复、句句带中文（玩法是「先心猜、翻开对答案」）
  const cards = await quiz.scanCardBatch(2)
  ok(cards.length > 0 && cards[0].length === 3, `扫读卡一张 3 句（实际 ${cards[0]?.length} 句）`)
  const cardWords = new Set(cards[0].map((it) => it.sense.word))
  ok(cardWords.size === cards[0].length, '一张扫读卡里目标词互不重复')
  ok(cards[0].every((it) => !!it.sentence.zh), '扫读卡每句都带中文翻译（翻开要对答案）')

  // 12b) 随便刷队列里混着扫读卡（每 10 题窗口插 1 张，只插在随便刷；
  //      不足 10 题一批时不插 —— 本夹具池子小，走的正是这个分支）
  const rq = await quiz.buildRandomQueue(50)
  const rScan = rq.filter((e) => e.kind === 'scan')
  const rQ = rq.filter((e) => e.kind === 'q')
  ok(rq.length === rQ.length + rScan.length, '队列 = 单题 + 扫读卡')
  const expectCards = Math.floor(rQ.length / 10)
  if (expectCards === 0) {
    ok(rScan.length === 0, `不足 10 题不插扫读卡（${rQ.length} 题 ${rScan.length} 张）`)
  } else {
    ok(rScan.length >= 1 && rScan.length <= expectCards,
       `扫读卡约 1/10 插入（${rScan.length} 张 / ${rQ.length} 题）`)
    ok(rScan.every((c) => c.items.length === 3), '队列里的扫读卡每张都是 3 句')
  }

  // 13) 返回键：同屏判断只看 path（query/hash 不算「换了一屏」）
  ok(nav.pathOf('/train?scope=due') === '/train', 'pathOf 去掉 query')
  ok(nav.pathOf('/word/x#top') === '/word/x', 'pathOf 去掉 hash')
  ok(nav.pathOf('/train?scope=due') === nav.pathOf('/train?scope=new'),
     '只差 query 的两条路由算同一屏（否则返回是空操作）')

  // 14) 拼写练习的比对口径（纯函数）
  ok(spell.spellMatched('Bank', 'bank'), '拼写比对忽略大小写')
  ok(spell.spellMatched('  bank ', 'bank'), '拼写比对忽略首尾空白')
  ok(spell.spellMatched('in   the  end', 'in the end'), '词内多余空格压成一个')
  ok(!spell.spellMatched('banc', 'bank'), '拼错就是不通过')
  ok(spell.spellHint('bank') === '首字母 b · 共 4 个字母', `提示给首字母与字母数（${spell.spellHint('bank')}）`)
  ok(spell.spellHint('in the end') === '首字母 i · 共 8 个字母', '多词短语的字母数不含空格')

  // 收尾
  ai.__setTransportForTest(null)
  ai.__setConfigForTest(null)
  await edit.purgeWord(W)
  await edit.purgeWord(F)
  ok((await db.words.get(W)) == null && (await db.words.get(F)) == null, 'AI 探针词已清干净')
}

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

/* ── 7d. 重新学一个意思 ──
 * 回滚快照只回内容（有意为之），于是「进度回到某个版本」一直没人管。
 * 这一条守的是：清零只碰 progress，**不碰作答流水** ——
 * 流水是历史（正确率、掌握判定都靠它），删了会让掌握凭空变。 */
{
  const t = await quiz.practicePool()
  const s = t[0]
  await quiz.recordAnswer(await quiz.makeQuestion(s.id), quiz.newSessionId(), 0, 'CORRECT', 700)
  await quiz.recordAnswer(await quiz.makeQuestion(s.id), quiz.newSessionId(), 1, 'CORRECT', 700)
  const before = await db.progress.get(s.id)
  const logBefore = await db.reviewLog.where('senseId').equals(s.id).count()
  ok(before.reps >= 2 && logBefore >= 2, '先练两次，造出 reps 与流水')

  await edit.resetProgress(s.id)
  const after = await db.progress.get(s.id)
  ok(after.reps === 0 && after.stability === 0 && after.mastered === 0, '学习记录清零了')
  ok(after.lastReview === null && after.dueAt === 0, '到期时间也重置（它会重新排期）')
  ok(
    (await db.reviewLog.where('senseId').equals(s.id).count()) === logBefore,
    '作答流水一条不少（那是历史，不是学习状态）',
  )
  ok(await quiz.buildQueue(50).then((qq) => qq.includes(s.id)), '清零之后它回到队列，可以重新学')
  // 复原：后面的用例还依赖这些进度
  await db.progress.put(before)
  ok(true, '复原了被这段用例改动的进度行')
}

/* ── 7c. 闲置衰减：掌握的词会回来 ──
 * 这一条守的是**行为**不是代码形状：守卫（verify_docs）判不了它，
 * 因为「衰减有没有接上」在源码里只差一个函数名。
 * 以前 decayIfIdle 写好了却没人调用，mastered 的词就永远消失 ——
 * 全绿、没报错、只是「学完就忘」这件事从来没发生过。 */
{
  const now = Math.floor(Date.now() / 1000)
  const day = 86400
  // 用**活着的**义项：前面那个合并用例已经把 a2 并没了，
  // 拿它来断言会得到一个和衰减无关的失败（测试自己踩坑，坑 40）。
  const live = await quiz.practicePool()
  const fresh = live[0].id
  const stale = live[1].id
  const before = {
    fresh: await db.progress.get(fresh),
    stale: await db.progress.get(stale),
  }

  // 刚标的：闲置 1 天、S=6（阈值 3×S=18 天，没超）→ 不该回来
  await db.progress.put({
    senseId: fresh, stability: 6, difficulty: 5, lastReview: now - 1 * day,
    dueAt: now + 5 * day, reps: 5, wrongN: 0, pendingN: 0, mastered: 1, rusty: 0,
  })
  // 放很久没碰的：闲置 40 天、S=6（超了）→ 该回来
  await db.progress.put({
    senseId: stale, stability: 6, difficulty: 5, lastReview: now - 40 * day,
    dueAt: now - 35 * day, reps: 5, wrongN: 0, pendingN: 0, mastered: 1, rusty: 0,
  })

  const q2 = await quiz.buildQueue(50)
  ok(!q2.includes(fresh), '刚练过的已掌握义项不会被排进队列')
  ok(q2.includes(stale), '闲置超过 3×S 的已掌握义项重新出现（学完就忘被实现了）')

  const decayed = await db.progress.get(stale)
  ok(decayed.rusty === 1, '衰减后 rusty 置 1（不然下次组队列又会被跳过）')
  ok(
    Math.abs(decayed.stability - 6) < 1e-9,
    `衰减只标 rusty、不改 S（仍是 ${decayed.stability}；真正的改写留给作答）`,
  )
  ok((await db.progress.get(fresh)).rusty === 0, '没超期的那个不动 rusty')

  // 答完一次之后 rusty 要清掉，否则它永远留在队列里
  const qq = await quiz.makeQuestion(stale)
  await quiz.recordAnswer(qq, quiz.newSessionId(), 0, 'CORRECT', 500)
  ok((await db.progress.get(stale)).rusty === 0, '重新练过之后 rusty 清零')

  // 复原：这一段改过两行的进度，不复原会污染后面所有断言
  await db.progress.put(before.fresh)
  await db.progress.put(before.stale)
  ok(true, '复原了被这段用例改动的进度行（不留残骸）')
}

/* ── 7b. 导入历史那一行怎么说话 ──
 * 存下来的 summary 有两种格式（内容包批量 / AI 单词），
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
  backup.importLine({ ts: 1, word: 'bank', summary: '新增义项0 例句10' }) === 'bank · 新增义项0 例句10',
  'AI 单词那套本来就是人话，原样用（不重译成空）',
  backup.importLine({ ts: 1, word: 'bank', summary: '新增义项0 例句10' }),
)
ok(
  backup.importLine({ ts: 1, word: 'bank', summary: '词+1 义+2 改3 句+5 冲突4' }) ===
    'bank · 1 词 · 2 义项 · 5 句 · 3 改 · 4 冲突',
  '「改」「冲突」后面没有加号，也要读得出来',
  backup.importLine({ ts: 1, word: 'bank', summary: '词+1 义+2 改3 句+5 冲突4' }),
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

/* ── 9. 标记清单闭环：标得出 → 导得出清单 → 能清（下游 = 人工 / AI）── */
{
  // 标记导出→清单闭环：内容侧 triage_flags.py 已随产线删除（git 历史可查），
  // 这节只验「标得出 + 导得出清单 + 能清」，清单的下游变成人工 / AI。
  const someSense = (await quiz.practicePool())[0]
  const sq = await quiz.makeQuestion(someSense.id)
  await quiz.flagQuestion(sq, '闭环测试标记')
  const fpath = path.join(HERE, '_flags_test.json')
  writeFileSync(fpath, JSON.stringify(flags.buildFlagsFile(await flags.listFlags())), 'utf8')
  const raw = readFileSync(fpath, 'utf8')
  ok(raw.includes(someSense.word), '导出清单里能看到被标记的词', raw.slice(0, 120))
  ok(raw.includes('闭环测试标记'), '标记备注也过去了（清单知道问题是什么）')
  await flags.clearFlags([sq.sentence.id])
  rmSync(fpath, { force: true })
}

/* ── 9b. 检查更新：版本比较与 Release 解析（不联网）── */
{
  const u = M.update
  ok(u.normalizeVersion('v0.10.0-debug') === '0.10.0', '版本号去掉 v 和 -debug 再比较')
  ok(u.compareVersions('v0.10.0', '0.9.9') > 0, '0.10.0 比 0.9.9 新（不能按字符串比）')
  ok(u.compareVersions('0.3.0-debug', '0.3.0') === 0, 'debug 后缀不参与版本比较')
  ok(u.compareVersions('0.2.0', '0.3.0') < 0, '0.2.0 比 0.3.0 旧')

  const rel = u.parseRelease({
    tag_name: 'v0.3.0',
    body: '修了几个问题。',
    html_url: 'https://github.com/blue-lemon0/Word/releases/tag/v0.3.0',
    published_at: '2026-10-30T00:00:00Z',
    assets: [
      { name: 'app-release.aab', browser_download_url: 'https://example.com/app.aab', size: 1 },
      { name: 'app-release.apk', browser_download_url: 'https://example.com/app.apk', size: 308 * 1024 },
    ],
  })
  ok(rel?.version === '0.3.0' && rel?.apkSize === 308 * 1024, 'Release 解析出正式版和 APK 大小')
  ok(rel?.notes === '修了几个问题。', 'Release 说明能显示出来')
  ok(
    u.plainNotes('## 本次更新\n- **扫读卡**：`ABC`\n[细节](https://example.com)') ===
      '本次更新\n· 扫读卡：ABC\n细节',
    'Release 说明去掉 Markdown 标记再显示',
  )
  ok(
    u.plainNotes('## A\r\n\r\n- **B**') === 'A\n\n· B',
    'Release 说明的 CRLF 也归一化，不把标题和列表粘在一起',
  )
  ok(rel && u.availability(rel, '0.2.0') === 'available', '本机旧 → 有更新')
  ok(rel && u.availability(rel, '0.3.0') === 'latest', '本机同版本 → 已是最新')
  ok(u.parseRelease({ tag_name: 'v0.4.0', prerelease: true }) === null, '预发布版不参与更新')
  ok(u.parseRelease({ tag_name: 'nightly' }) === null, '不是版本号的 tag 直接忽略')
}

console.log(bad ? `\n${bad} 处失败` : '\n数据层端到端：全绿')
process.exitCode = bad ? 1 : 0