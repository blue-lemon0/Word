/** 拼写练习的比对与提示 —— 纯函数，方便测。
 *
 *  ★ 比对口径只该有一处：忽略大小写、首尾空白、词内多余空格。
 *    散落在组件里写一遍 `a.trim().toLowerCase() === b...` 迟早两边不一样。
 *  ★ 提示只给「首字母 + 字母数」：再多就等于把答案说出来了。
 */

export function normSpell(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function spellMatched(input: string, word: string): boolean {
  return normSpell(input) === normSpell(word)
}

/** 「首字母 a · 共 7 个字母」；空词返回空串 */
export function spellHint(word: string): string {
  const w = word.trim()
  if (!w) return ''
  const letters = w.replace(/\s/g, '').length
  return `首字母 ${w[0]} · 共 ${letters} 个字母`
}
