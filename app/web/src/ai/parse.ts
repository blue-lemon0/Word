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
  /** 当前音标 —— 用来判断 AI 给的音标是不是「没变」（没变就不该冒出一条提案） */
  ipa: string
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
  /** sense.add 自带的例句（新义项没有编号，例句只能跟义项一起提） */
  sentences?: { en?: string; zh?: string }[]
  /** sense.update：熟词僻义 */
  trap?: number | boolean
  /** word.update：音标 */
  ipa?: string
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
      // note 是**给学习者的辨析线索**，不是给我们的操作建议。
      // 真机输出里见过「保留语法义，但例句要换；另补“外观、样子”义」这种句子 ——
      // 它进了 note 就变成用户看到的那行提示，既不像释义也不像提示。
      const note = s(p.note)
      const isInternalTalk = /例句|义项|建议|补一|换掉|删掉|合并|拆分/.test(note)
      if (note && note !== sense.note && !isInternalTalk) patch.note = note
      if (s(p.glossEn) && s(p.glossEn) !== sense.glossEn) patch.glossEn = s(p.glossEn)
      // TRAP：只在**变**的时候出提案（已经是 1 的再提一次没有任何意义，
      // 却会让提案列表里全是噪音）
      if (p.trap != null) {
        const want = p.trap === true || p.trap === 1 ? 1 : 0
        if (want !== sense.trap) patch.trap = want
      }
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
      // 新义项自带的例句：逐条过「必须含目标词」这道门槛，最多留 2 条。
      // 模型偶尔会把某句写得漂亮但里面没有目标词 —— 那种句子进库就是一张
      // 永远答不对的卡（与 sentence.add 同一条判据）。
      const rawSents = Array.isArray(p.sentences) ? p.sentences : []
      const sentences: { en: string; zh?: string }[] = []
      for (const rs of rawSents.slice(0, 3)) {
        const en = s(rs?.en)
        if (!en) continue
        if (!sentenceHasWord(en, bind.word)) {
          dropped.push(`新义项「${gloss}」的一句例句里找不到「${bind.word}」`)
          continue
        }
        if (sentences.some((x) => x.en === en)) continue
        sentences.push({ en, zh: s(rs?.zh) || undefined })
        if (sentences.length >= 2) break
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
        sentences: sentences.length ? sentences : undefined,
      })
    } else if (kind === 'word.update') {
      // 音标：只接受「看起来像音标」的一小段（去掉可能带的斜杠）。
      // 模型偶尔会在这里塞一整句解释 —— 那种东西进了 Word.ipa 就永远显示成怪东西。
      const ipa = s(p.ipa).replace(/^\/+|\/+$/g, '')
      if (!ipa) {
        dropped.push('word.update 没有给音标')
        continue
      }
      if (ipa.length > 40) {
        dropped.push('word.update 的音标太长，不像音标')
        continue
      }
      // ★ **只补不改**：已经有音标时一律不动。
      //   真机上出现过 AI 把一个对的 /ˈæspɛkt/ 改成 /æspekt/（音素对、重音丢了）——
      //   模型判断“音标对不对”并不可靠，而重音符号对学习是有用的信息。
      //   缺音标时补上是纯收益；已有音标时改写是纯风险。
      if (bind.ipa) {
        dropped.push('已有音标，不做改写（只补缺）')
        continue
      }
      const key = `w:${bind.word}:${ipa}`
      if (dup.has(key)) continue
      dup.add(key)
      out.push({
        id: `p${out.length + 1}`,
        kind: 'word.update',
        word: bind.word,
        ipa,
        why: s(p.why),
      })
    } else {
      dropped.push(`不认识的 kind=${kind || '（空）'}`)
    }
  }

  const note = s(raw.note) || 'ok'
  return { proposals: out, note, dropped }
}
