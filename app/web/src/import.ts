/** 导入 —— 一套代码吃两种 JSON
 *
 *  ① 管道产物 build/bundle/cards_v2.json（format: "word-bundle"）
 *     —— content-kit pipeline 的批量输出
 *
 *  ② AI 产出（format: "word.import"）
 *     —— 用户在意思页点「复制 AI 模板」，粘回来。schema 见
 *        docs/DESIGN-词库系统v2.md §6.3
 *
 *  之所以统一：AI 补例句和管道补例句是同一件事，都是「把 JSON 变成可背的义项」。
 *  分成两套代码就会出现「管道能导入但 AI 不能」这种不一致。
 *
 *  ★ 合并策略（用户定的 A 方案）：中文释义冲突默认**保留本地**，
 *    只回报冲突数量，不自动覆盖。用户去意思页逐项对比后再决定。
 */
import { db } from './db'
import { snapshot } from './backup'
import type { Sense, Sentence, Word, Progress, ImportLog } from './types'

/* ── 两种输入的宽松形状 ── */

interface RawSentence {
  text?: string
  en?: string
  form?: string
  clue?: string
  spanStart?: number
  spanLen?: number
  translation?: string
  zh?: string
  note?: string
  source?: string
}

interface RawCard {
  id?: string
  word: string
  senseId?: string
  slot?: number
  pos?: string
  ipa?: string
  gloss: string
  glossEn?: string
  note?: string
  trap?: number
  tier?: string
  needsRefine?: number
  sentences?: RawSentence[]
}

interface RawBundle {
  format?: string
  version?: string
  cards?: RawCard[]
}

interface RawWordImport {
  format?: string
  word?: string
  ipa?: string
  senses?: Array<RawCard & { slot?: number }>
}

export interface ImportReport {
  wordsAdded: number
  sensesAdded: number
  sensesUpdated: number
  sentencesAdded: number
  sentencesUpdated: number
  /** 中文释义与本地不一致的义项 —— 只报不改 */
  conflicts: Array<{ word: string; slot: number; local: string; incoming: string }>
  errors: string[]
}

function emptyReport(): ImportReport {
  return {
    wordsAdded: 0,
    sensesAdded: 0,
    sensesUpdated: 0,
    sentencesAdded: 0,
    sentencesUpdated: 0,
    conflicts: [],
    errors: [],
  }
}

/* ── 这份文件到底是什么 ── */

/**
 * 认出一份 JSON 是哪一类的导入件。
 *
 *  **为什么值得有这个函数**：三种导入件的 `format` 字段各不相同，
 *  而用户手上只有「一个 .json 文件」，他不该、也无法自己判断该点哪个按钮。
 *  过去是两个入口（内容包 / 备份），选错了还给一句「恢复完成，1 处跳过：
 *  不是 word.backup 文件」—— 用成功话术报告了一次彻底的拒绝（坑 48）。
 *
 *  认得出就按类型走，认不出就**说清它是什么、期望什么**，
 *  不给「跳过 N 处」这种听起来像部分成功的说法。
 */
export type ImportKind = 'bundle' | 'backup' | 'wordImport' | 'unknown'

export function classifyImport(json: unknown): { kind: ImportKind; format: string } {
  const format =
    typeof json === 'object' && json !== null && typeof (json as { format?: unknown }).format === 'string'
      ? (json as { format: string }).format
      : ''
  const obj = json as
    | { word?: unknown; cards?: unknown; words?: unknown; senses?: unknown }
    | null
  if (format === 'word-bundle') return { kind: 'bundle', format }
  if (format === 'word.backup') return { kind: 'backup', format }
  if (format === 'word.import') return { kind: 'wordImport', format }
  // 没有 format 字段时按结构兜底认一次：老文件只有靠形状才认得出
  if (obj && Array.isArray(obj.cards)) return { kind: 'bundle', format: '(无 format，按结构认成内容包)' }
  if (obj && typeof obj.word === 'string' && Array.isArray(obj.senses)) {
    return { kind: 'wordImport', format: '(无 format，按结构认成单词增量)' }
  }
  if (obj && Array.isArray(obj.words)) return { kind: 'backup', format: '(无 format，按结构认成备份)' }
  return { kind: 'unknown', format }
}

/** 认不出来时给用户的一句话：要说他手上这份是什么、期望什么。 */
export function unknownFormatText(format: string): string {
  const seen = format ? `它的 format 是「${format}」` : '文件里没有 format 字段'
  return `认不出这份文件（${seen}）。\n支持三种：content-kit 的 cards.json、本应用导出的备份、AI 按「复制给 AI」回来的单个词。`
}

/* ── 例句定位目标词 ── */

function locate(text: string, form: string): { spanStart: number; spanLen: number } {
  if (!form) return { spanStart: -1, spanLen: 0 }
  const i = text.toLowerCase().indexOf(form.toLowerCase())
  if (i >= 0) return { spanStart: i, spanLen: form.length }
  return { spanStart: -1, spanLen: 0 }
}

function normalizeSentence(raw: RawSentence, senseId: string, idx: number): Sentence {
  const en = (raw.text ?? raw.en ?? '').trim()
  const form = (raw.form ?? '').trim()
  // 管道给了 spanStart 就用；AI 漏了就在文本里找一遍
  const auto = locate(en, form)
  const hasSpan = typeof raw.spanStart === 'number' && raw.spanStart >= 0
  return {
    senseId,
    idx,
    en,
    zh: (raw.translation ?? raw.zh ?? '').trim(),
    spanStart: hasSpan ? (raw.spanStart as number) : auto.spanStart,
    spanLen: hasSpan ? ((raw.spanLen as number) || form.length) : auto.spanLen,
    form,
    clue: (raw.clue ?? '').trim(),
    flagged: 0,
    flagNote: '',
  }
}

/* ── UUID（浏览器原生）── */

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // 兜底：老 WebView
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/* ── 主流程 ── */

export async function importBundle(input: unknown): Promise<ImportReport> {
  const rep = emptyReport()
  if (typeof input !== 'object' || input === null) {
    rep.errors.push('顶层不是对象')
    return rep
  }
  const obj = input as RawBundle & RawWordImport

  // 归一成一张卡一个义项的扁平表
  let cards: RawCard[]
  if (Array.isArray(obj.cards)) {
    cards = obj.cards
  } else if (obj.word && Array.isArray(obj.senses)) {
    cards = obj.senses.map((s, i) => ({
      ...s,
      word: obj.word as string,
      slot: s.slot ?? i + 1,
      senseId: `s${s.slot ?? i + 1}`,
    }))
  } else {
    rep.errors.push('既没有 cards 数组，也没有 word + senses 数组 —— 格式不认识')
    return rep
  }

  // 导入前存一份快照。三条导入路径里只有这里原本不存，
  // 于是「导入翻车了回不去」这件事只在这一条上成立 —— 入口统一之后更扎眼：
  // 同一个按钮进来的东西，备份能回滚、AI 导入能回滚、内容包不能。
  // 它确实是纯增量（只加不删），但「纯增量」不等于「不会写坏字段」。
  await snapshot(`导入内容包前（${cards.length} 张卡）`)

  const t = Date.now()
  const importWords = new Set<string>()

  // importLog 必须在事务范围内：IndexedDB 里事务外的写操作会直接报
  // NotFoundError（对象库不在事务 scope 里），而且导入记录与导入内容应当同生共死。
  await db.transaction(
    'rw',
    db.words,
    db.senses,
    db.sentences,
    db.progress,
    db.importLog,
    async () => {
    for (const card of cards) {
      const word = (card.word ?? '').trim()
      const gloss = (card.gloss ?? '').trim()
      if (!word) {
        rep.errors.push('有个义项没有 word 字段')
        continue
      }
      if (!gloss) {
        rep.errors.push(`${word}: 有义项没有中文释义，跳过`)
        continue
      }
      importWords.add(word)

      // ── 词条 ──
      const existWord = await db.words.get(word)
      if (!existWord) {
        const w: Word = {
          word,
          ipa: (card.ipa ?? '').trim(),
          hidden: 0,
          createdAt: t,
          updatedAt: t,
        }
        await db.words.put(w)
        rep.wordsAdded++
      } else if (card.ipa && !existWord.ipa) {
        await db.words.update(word, { ipa: card.ipa, updatedAt: t })
      }

      // ── 义项：按 slot 对齐，不按顺序 ──
      const slot = card.slot ?? (Number(String(card.senseId ?? 's1').replace(/\D/g, '')) || 1)
      const existing = await db.senses.where('[word+slot]').equals([word, slot]).first()

      let senseId: string
      if (existing) {
        senseId = existing.id
        const localGloss = existing.gloss
        if (localGloss !== gloss) {
          // A 方案：只报冲突，不覆盖
          rep.conflicts.push({ word, slot, local: localGloss, incoming: gloss })
        } else {
          // 释义一致才允许补字段
          const patch: Partial<Sense> = { updatedAt: t }
          if (card.glossEn && card.glossEn !== existing.glossEn) patch.glossEn = card.glossEn
          if (card.note) patch.note = card.note
          if (card.pos && !existing.pos) patch.pos = card.pos
          if (Object.keys(patch).length > 1) await db.senses.update(senseId, patch)
          rep.sensesUpdated++
        }
      } else {
        senseId = uuid()
        const s: Sense = {
          id: senseId,
          word,
          slot,
          pos: (card.pos ?? '').trim(),
          gloss,
          glossEn: (card.glossEn ?? '').trim(),
          note: (card.note ?? '').trim(),
          // trap / tier 是 SRS classify() 的输入，必须落库，否则起始间隔全错
          trap: (card.trap as 0 | 1) ?? 0,
          tier: (card.tier as Sense['tier']) ?? '',
          needsRefine: (card.needsRefine as 0 | 1) ?? 0,
          deletedAt: null,
          createdAt: t,
          updatedAt: t,
        }
        await db.senses.put(s)
        rep.sensesAdded++

        const p: Progress = {
          senseId,
          stability: 0,
          difficulty: 8,
          lastReview: null,
          dueAt: 0,
          reps: 0,
          wrongN: 0,
          pendingN: 0,
          mastered: 0,
          rusty: 0,
        }
        await db.progress.put(p)
      }

      // ── 例句：按英文文本去重，不按 idx（AI 重排句子不该产生重复）──
      for (let i = 0; i < (card.sentences?.length ?? 0); i++) {
        const raw = card.sentences![i]
        const en = (raw.text ?? raw.en ?? '').trim()
        if (!en) continue
        const already = await db.sentences.where('senseId').equals(senseId).filter((s) => s.en === en).first()
        if (already) {
          if (!already.zh && (raw.translation ?? raw.zh)) {
            await db.sentences.update(already.id!, { zh: (raw.translation ?? raw.zh ?? '').trim() })
            rep.sentencesUpdated++
          }
          continue
        }
        const count = await db.sentences.where('senseId').equals(senseId).count()
        await db.sentences.add(normalizeSentence(raw, senseId, count))
        rep.sentencesAdded++
      }
    }

    // 记录导入历史
    const log: ImportLog = {
      ts: t,
      word: [...importWords].join(',').slice(0, 200),
      source: obj.format ?? 'unknown',
      summary: `词+${rep.wordsAdded} 义+${rep.sensesAdded} 改${rep.sensesUpdated} 句+${rep.sentencesAdded} 冲突${rep.conflicts.length}`,
    }
    if (importWords.size) await db.importLog.add(log)
    },
  )

  return rep
}

/* ── 供「复制 AI 模板」用 ── */

/** 给 AI 看的完整提示词：现有内容 + 要求 + 输出格式。
 *  slot 一并给出，是为了让人和 AI 说的是同一条义项 —— 否则 AI 拆出来的
 *  意思对不上号，导入时就得全靠猜。 */
export function aiPrompt(
  word: string,
  ipa: string,
  senses: Array<{ slot: number; gloss: string; glossEn?: string; note?: string }>,
): string {
  let t = `单词: ${word}\n音标: ${ipa || '（无）'}\n\n`
  for (const s of senses) {
    t += `-- 意思 s${s.slot} --\n中文释义: ${s.gloss}\n`
    if (s.glossEn) t += `英文释义: ${s.glossEn}\n`
    if (s.note) t += `备注: ${s.note}\n`
    t += '\n'
  }
  t += `请核验并补全：\n`
  t += `1. 上述中文释义是否准确？不准确请给出更好的。\n`
  t += `2. 为每个意思造 5 个英文例句 + 中文翻译，每句必须能体现该义项的独特用法（能与同词其他义项区分开）。\n`
  t += `3. 只输出下面这个 JSON，不要任何其他文字。sentences[].form 填例句里实际出现的词形（如 laid/cast），\n`
  t += `   translation 填整句中文翻译，clue 填句子里能体现该义项的语境线索（clue 要能在句中找到）。\n\n`
  t += `{"word":"${word}","senses":[\n`
  t +=
    senses
      .map(
        (s) =>
          `  {\n    "slot": ${s.slot},\n    "gloss": "...",\n    "glossEn": "...",\n` +
          `    "note": "...",\n    "sentences": [\n      {"text": "...", "form": "${word}", "clue": "...", "translation": "..."}\n    ]\n  }`,
      )
      .join(',\n')
  t += `\n]}`
  return t
}

/** 复制到剪贴板：优先异步 API，失败退回 execCommand（老 WebView / 非 https）*/
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
