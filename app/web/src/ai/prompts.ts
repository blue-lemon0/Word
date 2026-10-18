/** 提示词 —— 全部集中在这里，别处不拼 prompt。
 *
 *  ★ 为什么集中：prompt 是这个 app 里**唯一会过期的代码**（模型换代、
 *    词库口径变、用户抱怨 AI 老改错）。分开写在各页里，改一次要翻五个文件；
 *    集中之后「AI 为什么这么改」只有一处答案。
 *
 *  ★ 所有动作都要求返回**同一份 JSON 形状**（`{note, proposals[]}`），
 *    差别只在约束条数。这样解析、缓存、应用、界面全部可以复用一套逻辑，
 *    加第四个动作只是多写一个 prompt 函数。
 *
 *  ★ 成本控制写在 prompt 里而不是代码里：只列「真有问题」的、最多 6 条、
 *    例句 12-20 词。这些约束省下来的 token 比任何参数调优都多。
 */
import type { ChatMessage } from './client'
import type { WordContext } from './types'

const SYSTEM = `你是英语学习词库的内容审校助手。你只输出严格 JSON（不要代码块、不要解释文字）。

判断标准：
- 释义 gloss 要与词性 pos、英文释义 glossEn 一致；中文要能区分同词的其它义项（近义/重复的要指出）。
- 例句必须真的用到「这个词的这个义项」，中文翻译要忠实；例句里不该出现目标词的其它义项。
- 例句用常见词、自然书面英语，12-20 个词，且必须包含目标词或它的屈折形式。
- 宁缺勿滥：只报告**确实有问题**的条目，没问题的不要列。改一条错的，胜过多改十条对的。`

const SHAPE = `输出 JSON：
{"note":"整体判断一句话；全部没问题就写 ok","proposals":[
 {"kind":"sense.update","slot":1,"gloss":"……","pos":"v.","note":"……","glossEn":"……","why":"为什么要改"},
 {"kind":"sentence.replace","sentenceId":12,"en":"新英文（含目标词或具屈折形式）","zh":"中文","why":"为什么要换"},
 {"kind":"sentence.add","slot":2,"en":"……","zh":"……","why":"为什么要补"},
 {"kind":"sense.add","gloss":"……","pos":"n.","why":"为什么要加这个义项"}
]}
字段都可以省略（只写你要改的那个）；slot / sentenceId 必须来自下面给出的编号，不要编。`

function ctxBody(c: WordContext): string {
  const senses = c.senses
    .map((s) => `  ${s.slot}. (${s.pos || '?'}) ${s.gloss}${s.glossEn ? ` | en: ${s.glossEn}` : ''}${s.note ? ` | note: ${s.note}` : ''}`)
    .join('\n')
  const sents = c.sentences.length
    ? c.sentences
        .map((s) => `  - sentenceId=${s.id} slot=${c.senses.find((x) => x.id === s.senseId)?.slot ?? '?'}: "${s.en}"${s.zh ? ` / "${s.zh}"` : ''}`)
        .join('\n')
    : '  （这个词还没有例句）'
  return `词条：${c.word}${c.ipa ? ` /${c.ipa}/` : ''}
义项（slot 是编号）：
${senses || '  （还没有义项）'}
例句（sentenceId 是编号）：
${sents}`
}

/** 审查一个词：义项与例句的错、缺、重复。一次请求覆盖整词（省 token 的关键）。 */
export function reviewWordPrompt(c: WordContext): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ctxBody(c)}

请审查：哪些释义与词性/英文不一致、哪些中文近义到分不开、哪些例句没有真正用到它该教的义项、
有没有明显缺的常用义项（最多补 1 条）。最多 6 条 proposal。
${SHAPE}`,
    },
  ]
}

/** 给某个义项补几条新例句（候选，让人挑）。 */
export function addSentencePrompt(
  c: WordContext,
  senseSlot: number,
  howMany = 3,
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ctxBody(c)}

只给 slot=${senseSlot} 这个义项补例句：生成 ${howMany} 条候选，场景各不相同，
每条都必须用上这个词的对应词性/义项，且不要和已有例句相似。全部用 kind="sentence.add"，slot=${senseSlot}。
${SHAPE}`,
    },
  ]
}

/** 换掉某一条例句：保留它要教的义项，换场景/换措辞。 */
export function replaceSentencePrompt(c: WordContext, sentenceId: number, why: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ctxBody(c)}

请**替换** sentenceId=${sentenceId} 这一句${why ? `（问题：${why}）` : ''}：
新句要教同一个义项，换一个不同的情境与措辞，不要和已有例句相似。只给 1 条，kind="sentence.replace"，sentenceId=${sentenceId}。
${SHAPE}`,
    },
  ]
}
