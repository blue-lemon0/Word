/** 导入对比 —— 「导入 JSON」那条最关键的路径。
 *
 *  设计前提（docs/DESIGN-词库系统v2.md §3.2）：
 *   导入不是「填表」，是**合并两个版本**。所以这里做的是两件事：
 *     1. planImport() 只读地算出差异，不写库；
 *     2. applyPlan() 按用户**逐条**给的决策写库。
 *   每个冲突单独决策，没有「全部用导入的」——批量覆盖就是丢数据的开始。
 *
 *  默认动作：释义保留本地（用户可能自己改过）、例句追加缺的、新义项采纳。
 */
import { db, ensureProgress } from './db'
import { normalizeSlots, uuid } from './edit'
import { flagIndexByText, reapplyFlags } from './flags'
import { snapshot } from './backup'
import { logImport, runImportTx } from './importWrite'
import type { Sense, Sentence } from './types'

/* ── 宽松输入形状：管道包与 AI 产出都吃 ── */

interface RawSentence {
  text?: string
  en?: string
  form?: string
  clue?: string
  translation?: string
  zh?: string
  note?: string
}

interface RawSense {
  senseId?: string
  slot?: number
  pos?: string
  ipa?: string
  gloss?: string
  glossEn?: string
  note?: string
  trap?: number
  tier?: string
  needsRefine?: number
  sentences?: RawSentence[]
}

export interface IncomingSentence {
  en: string
  zh: string
  form: string
  clue: string
  note: string
}

export interface IncomingSense {
  slot: number
  pos: string
  gloss: string
  glossEn: string
  note: string
  trap: 0 | 1
  tier: Sense['tier']
  needsRefine: 0 | 1
  sentences: IncomingSentence[]
}

export interface PlanSense {
  key: string
  word: string
  slot: number
  kind: 'new' | 'update'
  local: Sense | null
  incoming: IncomingSense
  /** 释义不一致 —— 必须让用户看见 */
  glossConflict: boolean
  /** 导入有、本地没有的句子 */
  newSentences: IncomingSentence[]
  /** 本地有、导入没有的句子 */
  localOnlySentences: Sentence[]
  localSentences: Sentence[]
}

export interface ImportPlan {
  word: string
  ipa: string
  senses: PlanSense[]
  /** 本地有、导入没有的义项（默认保留） */
  localOnly: Sense[]
  errors: string[]
}

export interface Decisions {
  /** 释义：保留本地 / 用导入的 */
  gloss: Record<string, 'keep' | 'take'>
  /** 例句：追加缺的 / 只保留本地 / 用导入的 */
  sentences: Record<string, 'append' | 'keep' | 'take'>
  /** 新义项是否采纳 */
  adopt: Record<string, boolean>
  /** 本地独有义项是否删除 */
  drop: Record<string, boolean>
}

export function defaultDecisions(plan: ImportPlan): Decisions {
  const gloss: Decisions['gloss'] = {}
  const sentences: Decisions['sentences'] = {}
  const adopt: Decisions['adopt'] = {}
  const drop: Decisions['drop'] = {}
  for (const s of plan.senses) {
    gloss[s.key] = s.kind === 'new' ? 'take' : 'keep'
    sentences[s.key] = s.kind === 'new' ? 'take' : 'append'
    adopt[s.key] = s.kind === 'new'
  }
  for (const s of plan.localOnly) drop[`${s.word}#s${s.slot}`] = false
  return { gloss, sentences, adopt, drop }
}

const slotOf = (raw: RawSense, i: number): number =>
  raw.slot ?? (Number(String(raw.senseId ?? '').replace(/\D/g, '')) || i + 1)

function normSentence(raw: RawSentence, word: string): IncomingSentence {
  return {
    en: (raw.text ?? raw.en ?? '').trim(),
    zh: (raw.translation ?? raw.zh ?? '').trim(),
    form: (raw.form ?? word).trim(),
    clue: (raw.clue ?? '').trim(),
    note: (raw.note ?? '').trim(),
  }
}

function normSense(raw: RawSense, word: string, i: number): IncomingSense {
  return {
    slot: slotOf(raw, i),
    pos: (raw.pos ?? '').trim(),
    gloss: (raw.gloss ?? '').trim(),
    glossEn: (raw.glossEn ?? '').trim(),
    note: (raw.note ?? '').trim(),
    trap: raw.trap ? 1 : 0,
    tier: (raw.tier ?? '') as Sense['tier'],
    needsRefine: raw.needsRefine ? 1 : 0,
    sentences: (raw.sentences ?? []).map((s) => normSentence(s, word)),
  }
}

/** 只读地算出差异。**不写库** —— 用户没点「确认导入」之前一个字都不动。 */
export async function planImport(input: unknown): Promise<ImportPlan> {
  const plan: ImportPlan = { word: '', ipa: '', senses: [], localOnly: [], errors: [] }
  if (typeof input !== 'object' || input === null) {
    plan.errors.push('顶层不是对象')
    return plan
  }
  const obj = input as { word?: string; ipa?: string; cards?: Array<RawSense & { word: string }>; senses?: RawSense[] }
  let word = ''
  let raws: RawSense[] = []
  if (Array.isArray(obj.cards)) {
    // word-bundle：卡片里自带 word，可能跨多个词 —— 多词导入走批量入口
    const words = new Set(obj.cards.map((c) => c.word).filter(Boolean))
    if (words.size > 1) {
      plan.errors.push('这是一个多词内容包，请在「词库」页用种子导入；这里只导入单个词')
      return plan
    }
    word = [...words][0] ?? ''
    raws = obj.cards
  } else if (obj.word && Array.isArray(obj.senses)) {
    word = obj.word.trim()
    raws = obj.senses
  } else {
    plan.errors.push('既没有 cards 数组，也没有 word + senses 数组 —— 格式不认识')
    return plan
  }

  // ── 必过校验（不通过整份拒绝）──
  if (!word) plan.errors.push('没有 word')
  if (!/^[A-Za-z][A-Za-z' -]*$/.test(word)) plan.errors.push(`word 不合法: "${word}"`)
  const incoming = raws.map((r, i) => normSense(r, word, i))
  for (const s of incoming) {
    if (!s.gloss) plan.errors.push(`${word} s${s.slot}: gloss 为空`)
    for (const t of s.sentences) {
      if (!t.en) plan.errors.push(`${word} s${s.slot}: 有例句没有英文原文`)
    }
  }
  const seen = new Set<string>()
  for (const s of incoming) {
    const k = s.glossEn.toLowerCase()
    if (!k) continue
    if (seen.has(k)) plan.errors.push(`${word}: 两个意思的英文释义完全相同 —— 会变成重复卡片`)
    seen.add(k)
  }
  if (plan.errors.length) return plan

  plan.word = word
  plan.ipa = (obj.ipa ?? raws[0]?.ipa ?? '').trim()

  const localWord = await db.words.get(word)
  if (localWord?.ipa && !plan.ipa) plan.ipa = localWord.ipa
  const localSenses = (await db.senses.where('word').equals(word).toArray()).filter(
    (s) => s.deletedAt == null,
  )
  const localBySlot = new Map(localSenses.map((s) => [s.slot, s]))
  const localSentences = await db.sentences.toArray()

  for (const inc of incoming) {
    const local = localBySlot.get(inc.slot) ?? null
    const mine = local ? localSentences.filter((s) => s.senseId === local.id) : []
    mine.sort((a, b) => a.idx - b.idx)
    const have = new Set(mine.map((s) => s.en))
    const incEn = new Set(inc.sentences.map((s) => s.en))
    plan.senses.push({
      key: `${word}#s${inc.slot}`,
      word,
      slot: inc.slot,
      kind: local ? 'update' : 'new',
      local,
      incoming: inc,
      glossConflict: !!local && local.gloss !== inc.gloss,
      newSentences: inc.sentences.filter((s) => !have.has(s.en)),
      localOnlySentences: mine.filter((s) => !incEn.has(s.en)),
      localSentences: mine,
    })
  }
  const touched = new Set(plan.senses.map((s) => s.slot))
  plan.localOnly = localSenses.filter((s) => !touched.has(s.slot))
  return plan
}

/** 写库。导入前自动存快照（可回滚），进度不动。 */
export async function applyPlan(plan: ImportPlan, d: Decisions): Promise<string> {
  if (plan.errors.length) throw new Error('这份导入没过校验，不能写入')
  await snapshot(`导入 ${plan.word} 之前`)
  const t = Date.now()
  let added = 0
  let sents = 0

  await runImportTx(async () => {
    if (!(await db.words.get(plan.word))) {
      await db.words.put({
        word: plan.word,
        ipa: plan.ipa,
        hidden: 0,
        createdAt: t,
        updatedAt: t,
      })
    } else if (plan.ipa) {
      await db.words.update(plan.word, { ipa: plan.ipa, updatedAt: t })
    }

    for (const ps of plan.senses) {
      if (ps.kind === 'new' && !d.adopt[ps.key]) continue
      const inc = ps.incoming

      if (ps.local) {
        const patch: Partial<Sense> = { updatedAt: t }
        if (d.gloss[ps.key] === 'take') patch.gloss = inc.gloss
        if (!ps.local.glossEn) patch.glossEn = inc.glossEn
        if (inc.note) patch.note = inc.note
        if (!ps.local.pos) patch.pos = inc.pos
        await db.senses.update(ps.local.id, patch)

        if (d.sentences[ps.key] === 'take') {
          // 标记长在句子行上：整份替换前先按原文存一份，替换后搬回去。
          // 否则「内容侧只改了译文、原文没变」这种情况，问题句会在修复
          // 落地的那一刻悄悄消失，没人知道它到底修没修。
          const prevFlags = await flagIndexByText(ps.local.id)
          for (const s of await db.sentences.where('senseId').equals(ps.local.id).toArray()) {
            await db.sentences.delete(s.id!)
          }
          await writeSentences(ps.local.id, inc.sentences, 0, plan.word)
          sents += inc.sentences.length
          await reapplyFlags(ps.local.id, prevFlags)
        } else if (d.sentences[ps.key] === 'append') {
          const start = await db.sentences.where('senseId').equals(ps.local.id).count()
          sents += await writeSentences(ps.local.id, ps.newSentences, start, plan.word)
        }
      } else {
        const id = uuid()
        await db.senses.put({
          id,
          word: plan.word,
          slot: inc.slot,
          pos: inc.pos,
          gloss: inc.gloss,
          glossEn: inc.glossEn,
          note: inc.note,
          trap: inc.trap,
          tier: inc.tier,
          needsRefine: inc.needsRefine,
          deletedAt: null,
          createdAt: t,
          updatedAt: t,
        })
        await ensureProgress(id)
        added++
        sents += await writeSentences(id, inc.sentences, 0, plan.word)
      }
    }

    // 本地有、导入没有，且用户选择删除的义项
    for (const s of plan.localOnly) {
      if (d.drop[`${s.word}#s${s.slot}`]) {
        await db.senses.update(s.id, { deletedAt: t, updatedAt: t })
      }
    }
    await normalizeSlots(plan.word)

    // ★ 记在事务**内**：IndexedDB 里事务外的写会因对象库不在 scope 直接报
    // NotFoundError（坑 25）。原来这里是事务外的 —— 两条导入路径就这一个
    // 不一致，靠 importWrite.runImportTx 抹平。
    await logImport({
      ts: t,
      word: plan.word,
      source: 'JSON 导入',
      summary: `新增义项${added} 例句${sents}`,
    })
  })
  return `已导入 ${plan.word}：新增义项 ${added}，例句 ${sents}`
}

async function writeSentences(
  senseId: string,
  list: IncomingSentence[],
  startIdx: number,
  word: string,
): Promise<number> {
  let n = 0
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    if (!s.en) continue
    const form = s.form || word
    const at = s.en.toLowerCase().indexOf(form.toLowerCase())
    await db.sentences.add({
      senseId,
      idx: startIdx + i,
      en: s.en,
      zh: s.zh,
      spanStart: at >= 0 ? at : -1,
      spanLen: at >= 0 ? form.length : 0,
      form: at >= 0 ? form : '',
      clue: s.clue,
      flagged: 0,
      flagNote: '',
    })
    n++
  }
  return n
}