/** 把 AI 的回复变成**可信的提案**。
 *
 *  ★ 这一层是安全边界：AI 说的 slot / sentenceId 一律要在这里对回库里
 *    真正存在的行。对不上就丢掉，并在 note 里说清「丢了几条」——
 *    宁可少应用一条，也不能因为一句幻觉去改另一张卡。
 *
 *  ★ 也在这里做**机械校验**（新句子里必须真有这个词），因为这是防幻觉里
 *    唯一不依赖模型自觉的一条：模型很容易写一句漂亮句子、但里面根本没有
 *    目标词，那种句子进了库就是一张永远答不对的卡。
 */
import { guessLemmas } from '../lookup'
import type { Sense, Sentence } from '../types'
import { AiError, type Proposal } from './types'

export interface Bind {
  word: string
  senses: Sense[]
  sentences: Sentence[]
}

interface RawProposal {
  kind?: string
  slot?: number
  sentenceId?: number
  gloss?: string
  pos?: string
  note?: string
  glossEn?: string
  en?: string
  zh?: string
  why?: string
}

export function extractJson(text: string): { note?: string; proposals?: RawProposal[] } {
  let t = text.trim()
  // 模型偶尔还是会包一层代码块
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  try {
    return JSON.parse(t) as { note?: string; proposals?: RawProposal[] }
  } catch {
    const a = t.indexOf('{')
    const b = t.lastIndexOf('}')
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1)) as { note?: string; proposals?: RawProposal[] }
      } catch {
        /* 落到下面统一报错 */
      }
    }
  }
  throw new AiError('parse', '回复里找不到合法 JSON')
}

/** 句子里是否真的出现了这个词（认屈折形式：goal → goals） */
export function sentenceHasWord(en: string, word: string): boolean {
  const w = word.toLowerCase()
  const toks = en.toLowerCase().match(/[a-z']+/g) ?? []
  return toks.some((t) => t === w || guessLemmas(t).includes(w))
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const n = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function parseProposals(
  text: string,
  bind: Bind,
): { proposals: Proposal[]; note: string; dropped: string[] } {
  const raw = extractJson(text)
  const dropped: string[] = []
  const bySlot = new Map(bind.senses.map((x) => [x.slot, x]))
  const bySentence = new Map(bind.sentences.map((x) => [x.id as number, x]))
  const out: Proposal[] = []
  const dup = new Set<string>()

  const list = Array.isArray(raw.proposals) ? raw.proposals.slice(0, 10) : []
  for (const p of list) {
    const kind = s(p.kind)
    if (kind === 'sense.update') {
      const sense = bySlot.get(n(p.slot) ?? -1)
      if (!sense) {
        dropped.push(`sense.update slot=${p.slot} 不存在`)
        continue
      }
      const patch: Partial<Sense> = {}
      if (s(p.gloss) && s(p.gloss) !== sense.gloss) patch.gloss = s(p.gloss)
      if (s(p.pos) && s(p.pos) !== sense.pos) patch.pos = s(p.pos)
      if (s(p.note) && s(p.note) !== sense.note) patch.note = s(p.note)
      if (s(p.glossEn) && s(p.glossEn) !== sense.glossEn) patch.glossEn = s(p.glossEn)
      if (!Object.keys(patch).length) {
        dropped.push(`sense.update slot=${sense.slot} 没有实际改动`)
        continue
      }
      const key = `u:${sense.id}:${JSON.stringify(patch)}`
      if (dup.has(key)) continue
      dup.add(key)
      out.push({
        id: `p${out.length + 1}`,
        kind: 'sense.update',
        senseId: sense.id,
        word: sense.word,
        slot: sense.slot,
        why: s(p.why),
        ...patch,
      } as Proposal)
    } else if (kind === 'sentence.replace') {
      const sen = bySentence.get(n(p.sentenceId) ?? -1)
      const en = s(p.en)
      if (!sen) {
        dropped.push(`sentence.replace sentenceId=${p.sentenceId} 不存在`)
        continue
      }
      if (!en) {
        dropped.push(`sentence.replace sentenceId=${sen.id} 没有给新句子`)
        continue
      }
      if (!sentenceHasWord(en, bind.word)) {
        dropped.push(`新句子里找不到「${bind.word}」`)
        continue
      }
      const key = `r:${sen.id}:${en}`
      if (dup.has(key)) continue
      dup.add(key)
      out.push({
        id: `p${out.length + 1}`,
        kind: 'sentence.replace',
        sentenceId: sen.id as number,
        label: `s${bySlot.get(bind.senses.find((x) => x.id === sen.senseId)?.slot ?? -1)?.slot ?? '?'} 第 ${sen.idx + 1} 句`,
        en,
        zh: s(p.zh) || sen.zh,
        why: s(p.why),
      })
    } else if (kind === 'sentence.add') {
      const sense = bySlot.get(n(p.slot) ?? -1)
      const en = s(p.en)
      if (!sense) {
        dropped.push(`sentence.add slot=${p.slot} 不存在`)
        continue
      }
      if (!en) {
        dropped.push(`sentence.add slot=${sense.slot} 没有给句子`)
        continue
      }
      if (!sentenceHasWord(en, bind.word)) {
        dropped.push(`新句子里找不到「${bind.word}」`)
        continue
      }
      const key = `a:${sense.id}:${en}`
      if (dup.has(key)) continue
      dup.add(key)
      out.push({
        id: `p${out.length + 1}`,
        kind: 'sentence.add',
        senseId: sense.id,
        label: `s${sense.slot} · ${sense.gloss || '（空释义）'}`,
        en,
        zh: s(p.zh),
        why: s(p.why),
      })
    } else if (kind === 'sense.add') {
      const gloss = s(p.gloss)
      if (!gloss) {
        dropped.push('sense.add 没有给释义')
        continue
      }
      const key = `n:${gloss}:${s(p.pos)}`
      if (dup.has(key)) continue
      dup.add(key)
      out.push({
        id: `p${out.length + 1}`,
        kind: 'sense.add',
        word: bind.word,
        gloss,
        pos: s(p.pos),
        why: s(p.why),
      })
    } else {
      dropped.push(`不认识的 kind=${kind || '（空）'}`)
    }
  }

  const note = s(raw.note) || 'ok'
  return { proposals: out, note, dropped }
}
