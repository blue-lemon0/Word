/** AI 的动作与结果形状 —— **与供应商无关**。
 *
 *  这一层只有两件事：把「一次 AI 调用」说清楚（`AiAction`），
 *  把「AI 想改什么」说清楚（`Proposal`）。
 *  provider（DeepSeek / 别的兼容接口）与传输方式（fetch / 原生桥）
 *  都在下面一层解决，这里一个字都不提。
 */
import type { Sense, Sentence } from '../types'

export type AiActionKind = 'reviewWord' | 'addSentence' | 'replaceSentence' | 'fillWord'

/** 一次提案：AI 想说「这里应该改成这样」。**它没有写库的能力**，
 *  只能提出；写库由用户点「应用」之后走 `ai/apply.ts` 的普通编辑原语。 */
export type Proposal =
  | {
      id: string
      kind: 'sense.update'
      senseId: string
      /** 显示用：这个词与槽位，让人知道改的是哪一条 */
      word: string
      slot: number
      gloss?: string
      pos?: string
      note?: string
      glossEn?: string
      why?: string
    }
  | {
      id: string
      kind: 'sentence.replace'
      sentenceId: number
      /** 改的是哪个义项下的第几句（显示用） */
      label: string
      en: string
      zh?: string
      why?: string
    }
  | {
      id: string
      kind: 'sentence.add'
      senseId: string
      label: string
      en: string
      zh?: string
      why?: string
    }
  | {
      id: string
      kind: 'sense.add'
      word: string
      gloss: string
      pos?: string
      why?: string
      /** 新义项自带的例句。
       *  ★ 为什么例句必须**跟着义项一起提**：义项还没落库时它没有 id/slot，
       *    单独一条 `sentence.add` 无从绑定（parse 会把它丢掉）。
       *    所以「新建义项 + 它的例句」是一个原子提案：要么一起进，要么都不进。 */
      sentences?: { en: string; zh?: string }[]
    }

/** 调用统计：只用来告诉用户「这次花了多少」，不做计费 */
export interface AiUsage {
  prompt: number
  completion: number
  total: number
}

export interface AiResult {
  action: AiActionKind
  proposals: Proposal[]
  /** AI 的总体说明（可以没有） */
  note: string
  usage?: AiUsage
  /** 这次是命中缓存还是真的一次调用 —— 界面上要能说清「这次没花钱」 */
  cached: boolean
}

/** 喂给提示词的词条上下文（只带 AI 判断需要的字段） */
export interface WordContext {
  word: string
  ipa: string
  senses: Pick<Sense, 'id' | 'slot' | 'pos' | 'gloss' | 'glossEn' | 'note' | 'tier' | 'trap'>[]
  sentences: Pick<Sentence, 'id' | 'senseId' | 'en' | 'zh' | 'form'>[]
}

export class AiError extends Error {
  readonly kind: 'no-config' | 'network' | 'http' | 'parse' | 'refused'
  readonly status?: number
  constructor(kind: AiError['kind'], message: string, status?: number) {
    super(message)
    this.kind = kind
    this.status = status
    this.name = 'AiError'
  }
}

/** 给界面看的错误话术 —— 别把「HTTP 401」原样丢给用户 */
export function describeAiError(e: unknown): string {
  if (!(e instanceof AiError)) return String(e)
  switch (e.kind) {
    case 'no-config':
      return '还没配置 AI：去「更多 → AI 助手」填 API Key'
    case 'network':
      return `连不上 AI 服务（${e.message}）。检查网络，或换个接入地址`
    case 'http':
      if (e.status === 401 || e.status === 403) return 'API Key 不对或没有权限（401/403）'
      if (e.status === 429) return '调用太频繁或额度用完了（429）'
      if (e.status === 402) return '账户余额不足（402）'
      return `AI 服务返回 ${e.status ?? '错误'}：${e.message}`
    case 'parse':
      return 'AI 的回复不是约定的 JSON，这次结果没法用（可以重试一次）'
    case 'refused':
      return `AI 没有给出可用建议：${e.message}`
  }
}
