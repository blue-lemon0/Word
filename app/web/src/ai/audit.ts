/** 整库体检 —— 把「一个个词点 AI 审查」变成一次能跑完的维护动作。
 *
 *  ★ 为什么不是「批量改」：体检只**收集提议**，应用仍然是逐词点。
 *    内容是这个产品的本体，一次错改污染的是复习计划（还是最贵的那种：
 *    改错了没人发现，因为界面上看起来一切正常）。
 *
 *  ★ 为什么可以随便重跑：结果按「内容指纹 + 模型名」缓存。
 *    跑过的词再跑一遍是 0 token；只有内容变过的词才会真的花钱。
 *    所以「上次没跑完」不是问题 —— 直接再点一次就行。
 *
 *  ★ 为什么串行 + 单次重试：并发请求既容易撞限流，又会在手机流量下
 *    互相拖慢。一次一个词、失败等 800ms 再试一次，够用了。
 */
import { allSentences, allWords, liveSenses } from '../db'
import { reviewWord } from './actions'
import { AiError, type AiResult } from './types'

export interface AuditTarget {
  word: string
  senses: number
  sentences: number
  /** 该词有几个「需精修」的义项 —— 最可能有问题，排在前面 */
  refine: number
  /** 该词还有没有音标（缺音标的也值得跑一遍） */
  hasIpa: boolean
}

/** 上次体检时间（只存在本机，用于界面显示「上次是几号」） */
const TS_KEY = 'wb.ai.audit'

export function lastAuditAt(): number {
  if (typeof localStorage === 'undefined') return 0
  const n = Number(localStorage.getItem(TS_KEY))
  return Number.isFinite(n) ? n : 0
}

export function markAudited(at = Date.now()): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(TS_KEY, String(at))
}

/**
 * 体检对象：**有义项的词**，按「最可能需要修」排序。
 *
 *  排序理由：一次体检要花 N 次调用（有钱也不该乱花），
 *  先跑的应该是「最像有问题」的：需精修 > 没音标 > 例句少 > 其它。
 */
export async function auditTargets(): Promise<AuditTarget[]> {
  const senses = await liveSenses()
  const sents = await allSentences()
  const byWord = new Map<string, AuditTarget>()
  const sentCount = new Map<string, number>()
  for (const s of sents) sentCount.set(s.senseId, (sentCount.get(s.senseId) ?? 0) + 1)

  for (const s of senses) {
    const t = byWord.get(s.word) ?? {
      word: s.word,
      senses: 0,
      sentences: 0,
      refine: 0,
      hasIpa: true,
    }
    t.senses += 1
    t.sentences += sentCount.get(s.id) ?? 0
    if (s.needsRefine) t.refine += 1
    byWord.set(s.word, t)
  }
  // 音标在 words 表上，单独补一次
  for (const w of await allWords()) {
    const t = byWord.get(w.word)
    if (t) t.hasIpa = !!w.ipa
  }

  const list = [...byWord.values()]
  list.sort((a, b) => {
    if (a.refine !== b.refine) return b.refine - a.refine
    if (a.hasIpa !== b.hasIpa) return a.hasIpa ? 1 : -1
    if (a.sentences !== b.sentences) return a.sentences - b.sentences
    return a.word.localeCompare(b.word)
  })
  return list
}

/** 体检一个词。
 *
 *  两种失败要分开对待：
 *   · 解析失败（模型这次没按 JSON 回）：**同一个词重试一次**，还不行就当作这个词失败，
 *     但**不中断整轮** —— 一个词的回包坏了不该让剩下十几个词白跑；
 *   · 限流 / 没余额 / 网络 / 没配置：整轮停下（继续跑只会刷出同样的错）。
 */
export async function auditOne(word: string): Promise<AiResult> {
  try {
    return await reviewWord(word)
  } catch (e) {
    if (e instanceof AiError && e.kind === 'parse') {
      await new Promise((r) => setTimeout(r, 300))
      return reviewWord(word)
    }
    const retryable =
      e instanceof AiError && (e.kind === 'network' || (e.kind === 'http' && (e.status ?? 0) >= 500))
    if (!retryable) throw e
    await new Promise((r) => setTimeout(r, 800))
    return reviewWord(word)
  }
}
