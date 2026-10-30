/** AI 的动作 —— 对上层只暴露「审词 / 审义项 / 补一句 / 换一句 / 补全」。
 *
 *  ★ 所有动作共用一条流水线（取上下文 → 拼提示词 → 查缓存 → 调一次
 *    → 解析成提案 → 写缓存）。新增动作只要写个 prompt 函数，
 *    再在下面加一个四行的包装 —— 这是「不专门为某个 AI 设计」的落点。
 *
 *  ★ 每个动作都是**一次请求**：审查整词时把该词的义项与例句一次带上，
 *    而不是「每个义项问一次」。这是省钱的主要手段（见 prompts.ts 的约束）。
 */
import { db, sensesOf } from '../db'
import { MIN_SENTENCES_PER_SENSE } from '../sentence-health'
import type { Sense, Sentence } from '../types'
import { cacheGet, cachePut, hashOf } from './cache'
import { chat } from './client'
import { isConfigured, loadConfig } from './config'
import { parseProposals } from './parse'
import {
  addSentencePrompt,
  fillWordPrompt,
  lemmaPrompt,
  replaceSentencePrompt,
  reviewSensePrompt,
  reviewWordPrompt,
} from './prompts'
import { promptFingerprint } from './prompt-store'
import { AiError, type AiActionKind, type AiResult, type Proposal, type WordContext } from './types'

interface Rows {
  word: string
  ipa: string
  senses: Sense[]
  sentences: Sentence[]
}

async function rowsOf(word: string): Promise<Rows> {
  const w = await db.words.get(word)
  const senses = await sensesOf(word)
  const sentences: Sentence[] = []
  for (const s of senses) {
    const list = await db.sentences.where('senseId').equals(s.id).toArray()
    sentences.push(...list.sort((a, b) => a.idx - b.idx))
  }
  return { word, ipa: w?.ipa ?? '', senses, sentences }
}

/** 提示词版本 —— 改 prompt 的**形状**（不是措辞微调）时手动 +1。
 *
 *  ★ 为什么要有它：缓存键里已经含内容指纹和提示词指纹，但前者不知道
 *    「提示词变了」、后者不知道「解析器变了」。换了个更强的模型、或者改了
 *    输出约束（parse.ts 能认的字段），旧缓存里的结果就不再代表现在的质量 ——
 *    这时候必须能把旧缓存整体作废。
 *
 *  ★ 日常改提示词**不需要**动它：文本指纹（promptFingerprint）已经进了缓存键，
 *    用户在「提示词管理」里改完，下一次调用就是新键。
 */
const PROMPT_VERSION = 'v4'

function requireSentencesForEverySense(ps: Proposal[], requiredSlots: number[] = []): string | null {
  const senses = ps.filter((p) => p.kind === 'sense.add' || p.kind === 'sense.update')
  if (!senses.length) return 'AI 没有给出任何义项，本次不应用'
  for (const p of senses) {
    const n = p.sentences?.length ?? 0
    if (n >= MIN_SENTENCES_PER_SENSE) continue
    const label = p.kind === 'sense.add' ? `「${p.gloss}」` : `s${p.slot}`
    return `AI 只给义项${label}配了 ${n} 句例句；每个义项至少要 ${MIN_SENTENCES_PER_SENSE} 句，本次不应用`
  }
  for (const slot of requiredSlots) {
    if (!senses.some((p) => p.kind === 'sense.update' && p.slot === slot)) {
      return `AI 没有补全占位义项 s${slot}，本次不应用`
    }
  }
  return null
}

function contextOf(r: Rows, focusSenseId?: string, focusSentenceId?: number): WordContext {
  // ★ 整词审查默认每个义项只带 2 句：一个词 4 个义项 × 5 句就是 20 句，
  //   光输入就要两三千 token。省下来的输入 token 是全库体检的主要开销（见 D40 第五节）。
  // ★ 针对某个义项的动作（审查/补句/换句）必须看全它自己的例句：
  //   只带头两句会让 AI 看不到第 3 句以后的问题，甚至看不到要换的那一句，
  //   于是它只能用「补一句」糊弄过去，或者换出一句同样错的。
  const focus = focusSenseId ? r.senses.find((s) => s.id === focusSenseId) : undefined
  const perSense = 2
  const picked: WordContext['sentences'] = []
  let omitted = 0
  const seen = new Map<string, number>()
  for (const s of r.sentences) {
    if (focus) {
      if (s.senseId !== focus.id) {
        omitted++
        continue
      }
    } else {
      const n = seen.get(s.senseId) ?? 0
      if (n >= perSense) {
        omitted++
        continue
      }
      seen.set(s.senseId, n + 1)
    }
    picked.push({
      id: s.id as number,
      senseId: s.senseId,
      en: s.en,
      zh: s.zh,
      form: s.form,
    })
  }
  return {
    word: r.word,
    ipa: r.ipa,
    senses: r.senses.map((s) => ({
      id: s.id,
      slot: s.slot,
      pos: s.pos,
      gloss: s.gloss,
      glossEn: s.glossEn,
      note: s.note,
      tier: s.tier,
      trap: s.trap,
    })),
    sentences: picked,
    omitted,
    focusSlot: focus?.slot,
    focusSentenceId: focus ? focusSentenceId : undefined,
  }
}

/** 一次「取缓存 → 调用 → 解析 → 写缓存」。
 *
 *  ★ 键的组成单独抽成 `cacheKeyOf`：体检的**预算预览**要提前算同一种键
 *    来判断「这个词是不是已经有缓存了」。如果两处各拼一遍，预览说「全免费」
 *    而实际照样花钱 —— 这种不一致比没有预览更糟。
 */
export function cacheKeyOf(
  action: AiActionKind,
  model: string,
  ctx: WordContext,
  extra = '',
  prompt = '',
): string {
  return hashOf([PROMPT_VERSION, action, model, extra, prompt, JSON.stringify(ctx)].join('|'))
}

/** 入库前判原形：句子里点到的生词可能是屈折形式（armies / went / studies）。
 *
 *  ★ 为什么要问 AI：lookup 的规则只能在**词库里已有**的形式上验证候选；
 *    未入库的词（正是要加的那些）规则只能瞎猜，went 这类不规则更是认不出。
 *  ★ 为什么不走 proposals：它不改库，只回答「这个词的原形是什么」。
 *  ★ 任何失败都返回空串：调用方退回原行为（用句中的形式建词条），
 *    加个生词不该卡在一次 AI 调用上。
 */
export async function resolveLemma(token: string, sentence = ''): Promise<string> {
  const w = token.trim().toLowerCase()
  if (!w) return ''
  const cfg = loadConfig()
  if (!isConfigured(cfg)) return ''
  const messages = lemmaPrompt(w, sentence)
  const key = hashOf([PROMPT_VERSION, 'lemma', cfg.model, promptFingerprint(messages), w, sentence].join('|'))
  const hit = await cacheGet(key)
  if (hit) return hit.payload
  try {
    const reply = await chat(messages, { json: true, maxTokens: 40, temperature: 0 })
    const m = /"word"\s*:\s*"([a-z][a-z'’-]{0,29})"/i.exec(reply.text)
    const base = (m?.[1] ?? '').toLowerCase()
    if (!base) return ''
    await cachePut(key, cfg.model, base)
    return base
  } catch {
    return ''
  }
}

/** 一次「取缓存 → 调用 → 解析 → 写缓存」。 */
async function run(
  action: AiActionKind,
  rows: Rows,
  messages: { role: 'system' | 'user'; content: string }[],
  extra = '',
  check?: (proposals: Proposal[]) => string | null,
  ctx = contextOf(rows),
): Promise<AiResult> {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) throw new AiError('no-config', 'AI 还没配置')

  const key = cacheKeyOf(action, cfg.model, ctx, extra, promptFingerprint(messages))
  const bind = { word: rows.word, ipa: rows.ipa, senses: rows.senses, sentences: rows.sentences }

  const hit = await cacheGet(key)
  if (hit) {
    const p = parseProposals(hit.payload, bind)
    const bad = check?.(p.proposals)
    if (bad) throw new AiError('refused', bad)
    return {
      action,
      proposals: p.proposals,
      note: p.note,
      cached: true,
    }
  }

  const reply = await chat(messages, { json: true })
  const p = parseProposals(reply.text, bind)
  const bad = check?.(p.proposals)
  if (bad) throw new AiError('refused', bad)
  await cachePut(key, cfg.model, reply.text)
  return {
    action,
    proposals: p.proposals,
    note: p.note + (p.dropped.length ? `（${p.dropped.length} 条建议不可用：${p.dropped[0]}）` : ''),
    usage: reply.usage,
    cached: false,
  }
}

/** 体检预算预览用：算出「审这个词」的缓存键**和**大概要多少 token。
 *
 *  ★ 键必须和 reviewWord 实际调用的一致 —— 包括提示词指纹。
 *    用户改过提示词之后，旧缓存确实不会再命中，预览也要如实说「还要花钱」。 */
export async function reviewSnapshot(
  word: string,
): Promise<{ key: string; chars: number } | null> {
  const rows = await rowsOf(word)
  if (!rows.senses.length) return null
  const ctx = contextOf(rows)
  return {
    key: cacheKeyOf('reviewWord', loadConfig().model, ctx, '', promptFingerprint(reviewWordPrompt(ctx))),
    chars: JSON.stringify(ctx).length,
  }
}

/** 审查一个词：义项与例句的问题，附补充建议。 */
export async function reviewWord(word: string): Promise<AiResult> {
  const rows = await rowsOf(word)
  if (!rows.senses.length) throw new AiError('refused', '这个词还没有义项，没什么可审的')
  return run('reviewWord', rows, reviewWordPrompt(contextOf(rows)))
}

/** 只审一个义项：带全它的例句，专治「同一类错在多句里反复出现」。
 *
 *  ★ 和 reviewWord 的区别不只是范围：这里**不截断这个义项的例句**。
 *    整词审查为了省 token 每义项只看 2 句；多句同错时 AI 看不到后面的，
 *    只能补一句最新的，前面的错句原样留着。
 *  ★ note 是用户临时写的一句补充要求，只影响这一次请求（进 prompt 指纹与缓存键）。 */
export async function reviewSense(senseId: string, note = ''): Promise<AiResult> {
  const sense = await db.senses.get(senseId)
  if (!sense) throw new AiError('refused', '这个义项不存在')
  const rows = await rowsOf(sense.word)
  const ctx = contextOf(rows, sense.id)
  return run(
    'reviewSense',
    rows,
    reviewSensePrompt(ctx, sense.slot, note.trim()),
    `sense:${senseId}`,
    undefined,
    ctx,
  )
}

/** 给某个义项补几条候选例句。 */
export async function addSentence(senseId: string, howMany = 3): Promise<AiResult> {
  const sense = await db.senses.get(senseId)
  if (!sense) throw new AiError('refused', '这个义项不存在')
  const rows = await rowsOf(sense.word)
  const ctx = contextOf(rows, sense.id)
  return run(
    'addSentence',
    rows,
    addSentencePrompt(ctx, sense.slot, howMany),
    `${senseId}:${howMany}`,
    undefined,
    ctx,
  )
}

/** 把一个空壳词补成能背的卡（义项 + 每义项 2 句例句）。
 *
 *  ★ 这是 D37「顺手加入词库」的收尾动作：占位义项一直留在「需精修」里
 *    不算完成，补上义项和例句才算。
 *  ★ 只对**空壳**用它：有正经释义的词应该走 reviewWord（审查），
 *    否则 AI 会试图重写已经有主的内容。
 *  ★ 全有或全无：每个义项都带够例句才采用，避免“只补了一个义项一句”的半成品。 */
export async function fillWord(word: string, howManySenses = 3): Promise<AiResult> {
  const rows = await rowsOf(word)
  const hollow = rows.senses.length === 0 && rows.sentences.length === 0
    ? true
    : rows.senses.every((s) => !s.gloss.trim())
  if (!hollow) {
    throw new AiError('refused', '这个词已经有释义了；要检查它请用「AI 审查」')
  }
  const requiredSlots = rows.senses.filter((s) => !s.gloss.trim()).map((s) => s.slot)
  return run(
    'fillWord',
    rows,
    fillWordPrompt(contextOf(rows), howManySenses),
    `fill:${howManySenses}`,
    (ps) => requireSentencesForEverySense(ps, requiredSlots),
  )
}

/** 换掉某一条例句（保留它要教的义项）。 */
export async function replaceSentence(sentenceId: number, why = ''): Promise<AiResult> {
  const sen = await db.sentences.get(sentenceId)
  if (!sen) throw new AiError('refused', '这句例句不存在')
  const sense = await db.senses.get(sen.senseId)
  if (!sense) throw new AiError('refused', '这句例句挂的义项不存在')
  const rows = await rowsOf(sense.word)
  const ctx = contextOf(rows, sense.id, sentenceId)
  return run(
    'replaceSentence',
    rows,
    replaceSentencePrompt(ctx, sentenceId, why),
    `sentence:${sentenceId}`,
    undefined,
    ctx,
  )
}
