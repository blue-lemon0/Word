/** 提示词 —— 全部集中在这里，别处不拼 prompt。
 *
 *  ★ 为什么集中：prompt 是这个 app 里**唯一会过期的代码**（模型换代、
 *    词库口径变、用户抱怨 AI 老改错）。分开写在各页里，改一次要翻五个文件；
 *    集中之后「AI 为什么这么改」只有一处答案。
 *
 *  ★ 能不能改文案：能。文本本身在 `prompt-registry.ts` 里，用户改过的版本
 *    存在 localStorage（见 `prompt-store.ts`），这里每次调用现场读取。
 *    这个文件只负责「哪段文本 + 哪些变量」拼成消息 —— 变量是代码算出来的
 *    上下文，不是文字，所以不进管理页。
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
import { renderPrompt } from './prompt-store'
import type { WordContext } from './types'

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

/** 审查类动作的消息：共用规则当 system，动作模板当 user。
 *
 *  「共用块」的可编辑性靠这一处收口：改 system 块，四个动作一起变。 */
function actionMessages(id: string, vars: Record<string, string>): ChatMessage[] {
  return [
    { role: 'system', content: renderPrompt('system', {}) },
    {
      role: 'user',
      content: renderPrompt(id, { ...vars, shape: renderPrompt('shape', {}) }),
    },
  ]
}

/** 审查一个词：义项与例句的错、缺、重复。一次请求覆盖整词（省 token 的关键）。 */
export function reviewWordPrompt(c: WordContext): ChatMessage[] {
  return actionMessages('reviewWord', { context: ctxBody(c) })
}

/** 给某个义项补几条新例句（候选，让人挑）。 */
export function addSentencePrompt(
  c: WordContext,
  senseSlot: number,
  howMany = 3,
): ChatMessage[] {
  return actionMessages('addSentence', {
    context: ctxBody(c),
    slot: String(senseSlot),
    howMany: String(howMany),
  })
}

/** 换掉某一条例句：保留它要教的义项，换场景/换措辞。 */
export function replaceSentencePrompt(c: WordContext, sentenceId: number, why: string): ChatMessage[] {
  return actionMessages('replaceSentence', {
    context: ctxBody(c),
    sentenceId: String(sentenceId),
    whyNote: why ? `（问题：${why}）` : '',
  })
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
  return actionMessages('fillWord', {
    context: ctxBody(c),
    senseCount: String(howManySenses),
    minSentences: String(MIN_SENTENCES_PER_SENSE),
  })
}

/** 判原形：句子里点到的生词多半带屈折（armies / went / studies），
 *  入库时按词典原形建词条，而不是把句子里的形式原样存进去。
 *
 *  ★ 为什么交给 AI 而不是规则：规则在**未入库**的词上只能猜 —— 而这里恰恰
 *    都是未入库的词。minister 会被 er 规则剥成 minist，went 更是完全认不出。
 *  ★ 为什么不走 proposals：它不提议改库，只回答一个问题（一个词），
 *    用最小请求，失败时调用方维持原行为。
 *  ★ 只有一条消息（没有单独的 system）：指令本身就是一句话，拆成两条
 *    反而多一个管理页条目；合在模板里让「判原形」这一块可以整段改。
 */
export function lemmaPrompt(token: string, sentence: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: renderPrompt('lemma', {
        token,
        sentenceLine: sentence ? `\n所在句子：${sentence}` : '',
      }),
    },
  ]
}
