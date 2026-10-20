/** 例句高亮：把「AI 给的一组词形」变成句中的字符区间。
 *
 *  ★ 为什么不让 AI 直接给 start/len：模型数字符不可靠，中文、标点、
 *    大小写一多就会偏。让它给**句中实际出现的词形**，这里用机械定位，
 *    偏不了；同一句里出现几个词形（go / went / going）也都能落成数组。
 *
 *  ★ 为什么每个词形找**所有**出现位置：句子里重复出现同一个目标词时，
 *    只高亮第一次会让用户以为后面那个不是它。全标出来更一致。
 */
import { guessLemmas } from './lookup'
import type { Sentence, SentenceMark } from './types'

const WORD_CHAR = /[A-Za-z0-9]/

function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD_CHAR.test(ch)
}

/** 在 text 中找 form 的所有整词出现（大小写不敏感，返回原句里的写法）。 */
export function locateMarks(text: string, form: string): SentenceMark[] {
  const needle = form.trim()
  if (!needle) return []
  const lower = text.toLowerCase()
  const target = needle.toLowerCase()
  const out: SentenceMark[] = []
  let from = 0
  while (from <= lower.length - target.length) {
    const i = lower.indexOf(target, from)
    if (i < 0) break
    const before = i > 0 ? text[i - 1] : undefined
    const after = i + needle.length < text.length ? text[i + needle.length] : undefined
    if (!isWordChar(before) && !isWordChar(after)) {
      out.push({ start: i, len: needle.length, form: text.slice(i, i + needle.length) })
    }
    from = i + Math.max(1, target.length)
  }
  return out
}

/** 把一组词形落成高亮数组：去重、按位置排序、丢掉重叠段。 */
export function marksFromForms(text: string, forms: readonly unknown[]): SentenceMark[] {
  const bySpan = new Map<string, SentenceMark>()
  for (const raw of forms) {
    if (typeof raw !== 'string') continue
    for (const m of locateMarks(text, raw)) {
      bySpan.set(`${m.start}:${m.len}`, m)
    }
  }
  const sorted = [...bySpan.values()].sort((a, b) => a.start - b.start || b.len - a.len)
  const out: SentenceMark[] = []
  for (const m of sorted) {
    const last = out[out.length - 1]
    if (last && m.start < last.start + last.len) continue
    out.push(m)
  }
  return out
}

/** 旧数据/手动添加：先按原形找，再按规则认屈折形式（规则只用于找，不改原形）。 */
export function marksForWord(text: string, word: string): SentenceMark[] {
  const exact = marksFromForms(text, [word])
  if (exact.length) return exact
  const w = word.toLowerCase()
  const tokens = text.match(/[A-Za-z'’-]+/g) ?? []
  const forms = tokens.filter((t) => guessLemmas(t).includes(w))
  return marksFromForms(text, forms)
}

/** 校验落库/传入的 marks；坏区间按 form 重找，最后才用单个 form 兜底。 */
export function normalizeMarks(
  text: string,
  marks: readonly SentenceMark[] | undefined,
  form = '',
): SentenceMark[] {
  const out = new Map<string, SentenceMark>()
  for (const m of marks ?? []) {
    if (!m || typeof m.form !== 'string' || !m.form.trim()) continue
    const start = Number(m.start)
    const len = Number(m.len)
    if (
      Number.isInteger(start) &&
      Number.isInteger(len) &&
      start >= 0 &&
      len > 0 &&
      start + len <= text.length &&
      text.slice(start, start + len).toLowerCase() === m.form.toLowerCase()
    ) {
      out.set(`${start}:${len}`, { start, len, form: text.slice(start, start + len) })
    } else {
      for (const found of locateMarks(text, m.form)) {
        out.set(`${found.start}:${found.len}`, found)
      }
    }
  }
  if (!out.size && form.trim()) {
    for (const found of locateMarks(text, form)) {
      out.set(`${found.start}:${found.len}`, found)
    }
  }
  const sorted = [...out.values()].sort((a, b) => a.start - b.start || b.len - a.len)
  const clean: SentenceMark[] = []
  for (const m of sorted) {
    const last = clean[clean.length - 1]
    if (last && m.start < last.start + last.len) continue
    clean.push(m)
  }
  return clean
}

/** 读一条例句的全部高亮：新数据用 marks，旧数据回退到 spanStart/spanLen/form。 */
export function marksOfSentence(
  s: Pick<Sentence, 'en' | 'marks' | 'form' | 'spanStart' | 'spanLen'>,
): SentenceMark[] {
  const fromMarks = normalizeMarks(s.en, s.marks)
  if (fromMarks.length) return fromMarks
  const start = s.spanStart
  const len = s.spanLen
  if (
    Number.isInteger(start) &&
    Number.isInteger(len) &&
    start >= 0 &&
    len > 0 &&
    start + len <= s.en.length &&
    !!s.form &&
    s.en.slice(start, start + len).toLowerCase() === s.form.toLowerCase()
  ) {
    return [{ start, len, form: s.en.slice(start, start + len) }]
  }
  return marksFromForms(s.en, [s.form])
}

/** 高亮词形（去重，保留原句大小写）；没有 marks 时用词条原形兜底。 */
export function formsOfSentence(
  s: Pick<Sentence, 'en' | 'marks' | 'form' | 'spanStart' | 'spanLen'>,
  word = '',
): string[] {
  const marks = marksOfSentence(s)
  const forms = marks.length ? marks.map((m) => m.form) : word ? [word] : []
  return [...new Set(forms.map((f) => f.toLowerCase()))]
}

/** 新数据写库时，把 marks[0] 镜像到旧的 spanStart/spanLen/form，旧代码仍能读。 */
export function legacySpanOf(marks: readonly SentenceMark[]): Pick<Sentence, 'spanStart' | 'spanLen' | 'form'> {
  const first = marks[0]
  return first
    ? { spanStart: first.start, spanLen: first.len, form: first.form }
    : { spanStart: -1, spanLen: 0, form: '' }
}
