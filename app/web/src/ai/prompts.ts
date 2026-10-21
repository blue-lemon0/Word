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
import { MIN_SENTENCES_PER_SENSE } from '../sentence-health'
import type { ChatMessage } from './client'
import type { WordContext } from './types'

const SYSTEM = `你是英语学习词库的内容审校助手。你只输出严格 JSON（不要代码块、不要解释文字）。

判断标准：
- 释义 gloss 要与词性 pos、英文释义 glossEn 一致；中文要能区分同词的其它义项（近义/重复的要指出）。
- 例句必须真的用到「这个词的这个义项」，中文翻译要忠实；例句里不该出现目标词的其它义项。
- 例句用常见词、自然书面英语，12-20 个词，且必须包含目标词或它的屈折形式。
- 每条例句必须带 highlights 数组：列出句中**所有**属于目标词的词形，包括三单、复数、过去式、过去分词、现在分词，以及 went / made / children 这类不规则变化。每个元素必须逐字出现在 en 里；同一词形只列一次；没有目标词就不要给这句。
- 目标词是一个词条：不同词性/义项挂在同一个词条下，绝不为了词性另建单词；词形变化只出现在例句的 highlights 里，不另建词条。
- 宁缺勿滥：只报告**确实有问题**的条目，没问题的不要列。改一条错的，胜过多改十条对的。
- why 是写给用户看的一句话：**不要出现 sentenceId / slot 这类内部编号**，
  用「原来那句」「第 2 个义项」这样的说法。`

const SHAPE = `输出 JSON：
{"note":"整体判断一句话；全部没问题就写 ok","proposals":[
 {"kind":"sense.update","slot":1,"gloss":"……","pos":"v.","note":"……","glossEn":"……","trap":0,"why":"为什么要改"},
 {"kind":"word.update","ipa":"ˈaːmi","why":"为什么要补/改音标"},
 {"kind":"sentence.replace","sentenceId":12,"en":"新英文（含目标词或屈折形式）","zh":"中文","highlights":["went"],"why":"为什么要换"},
  {"kind":"sentence.add","slot":2,"en":"……","zh":"……","highlights":["goes","went"],"why":"为什么要补"},
  {"kind":"sense.add","gloss":"……","pos":"n.","why":"为什么要加这个义项","sentences":[{"en":"……","zh":"……","highlights":["……"]}]}
]}
字段都可以省略（只写你要改的那个）；slot / sentenceId 必须来自下面给出的编号，不要编。
"trap" 是熟词僻义标记：0/1。只在「这个词日常最熟的意思是别的、而这个义项生僻」时才给 1，
它是新卡起始间隔的依据，宁可漏标也不要乱标。`

function ctxBody(c: WordContext): string {
  const senses = c.senses
    .map((s) => `  ${s.slot}. (${s.pos || '?'}) ${s.gloss}${s.glossEn ? ` | en: ${s.glossEn}` : ''}${s.note ? ` | note: ${s.note}` : ''}${s.trap ? ' | [已标熟词僻义]' : ''}`)
    .join('\n')
  const sents = c.sentences.length
    ? c.sentences
        .map((s) => `  - sentenceId=${s.id} slot=${c.senses.find((x) => x.id === s.senseId)?.slot ?? '?'}: "${s.en}"${s.zh ? ` / "${s.zh}"` : ''}`)
        .join('\n')
    : '  （这个词还没有例句）'
  const sentNote = c.omitted ? `  （另外还有 ${c.omitted} 句没列出来，只列了每个义项的头两句）` : ''
  return `词条：${c.word}${c.ipa ? ` /${c.ipa}/` : '（音标缺失）'}
义项（slot 是编号）：
${senses || '  （还没有义项）'}
例句（sentenceId 是编号）：${sentNote}
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
有没有明显缺的常用义项（最多补 1 条）、**音标缺失或明显错**、**哪个义项是熟词僻义**（trap=1，谨慎）。
最多 6 条 proposal。
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
每条都要给 highlights（句中实际出现的所有目标词词形，含不规则变化）。
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
必须给 highlights（句中实际出现的所有目标词词形，含不规则变化）。
${SHAPE}`,
    },
  ]
}

/** 把一个「空壳词」补成能背的卡：义项 + 每个义项 2 句例句。
 *
 *  ★ 这个动作为 D37 的「顺手加入词库」收尾：点词 → 不在库里 → 加进来
 *    （占位义项）→ 让 AI 一次补齐。没有它，占位词条会一直躺在「需精修」里。
 *
 *  ★ 例句跟着义项走：新义项还没有 id/slot，单独给 `sentence.add` 无从绑定；
 *    已有占位义项走 `sense.update`，也要在同一条提案里带例句。
 */
export function fillWordPrompt(c: WordContext, howManySenses = 3): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ctxBody(c)}

这个词在词库里是**空壳**（没有释义，或只有占位义项）。请把它补成能背的卡：
1. 给 ${howManySenses} 个以内最常用的义项（按常用度排序）；如果已有占位义项（slot 有编号但 gloss 为空或明显不对），
   用 kind="sense.update" + 那个 slot 直接改写它，不要重复新建；
2. **每个义项都必须带 ${MIN_SENTENCES_PER_SENSE} 条例句**，写在同一条提案的
   "sentences":[{"en":"……","zh":"……","highlights":["……"]}, …] 里。
   kind="sense.add" 和 kind="sense.update" 都一样：新义项还没有编号，占位义项也要一次补全；
3. 不要只给其中一个义项配例句。**要么所有义项都配齐 ${MIN_SENTENCES_PER_SENSE} 句，要么整份 proposals 返回空数组**，
   只补一半的结果不会被采用；
4. 每条例句都必须真的用上这个词（可以屈折变化），12-20 个词，场景各不相同，自然书面英语，并给 highlights
   （句中实际出现的所有目标词词形，含 went / made 这类不规则变化）；
5. 所有词性都作为**同一个词条**下的不同义项，不要按词性另造词条；词条没有音标时，
   用 kind="word.update" 给一个（英式或美式都可，只写音标本身）。

${SHAPE}
kind="sense.add" 和 kind="sense.update" 的例句都写在提案的 "sentences" 数组里。例如：
{"kind":"sense.update","slot":1,"gloss":"……","sentences":[{"en":"……","zh":"……","highlights":["……"]},{"en":"……","zh":"……","highlights":["……"]}]}`,
    },
  ]
}
