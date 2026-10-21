/** 出题 —— 组队列、凑选项、落一次作答。
 *
 *  三条口径都在 docs/DESIGN-词库系统v2.md §10 里：
 *   · 出题范围 = 存活义项 × 到期/新卡；被标记的句子不进池
 *   · 英文释义**只在答题后**出现（出题时露 = 泄题）
 *   · 「我不会」按 WRONG 记 —— 诚实放弃不能比乱蒙更划算
 */
import { allSentences, allProgress, cachedNow, liveSenses, db } from './db'
import { applyReview, decayIfIdle, isMastered, type ReviewOutcome } from './srs'
import { toast } from './toast'
import type { Progress, ReviewLog, Sense, Sentence, SrsCard } from './types'
import { masteryOf } from './types'

export const SESSION_SIZE = 20

export interface Question {
  sense: Sense
  ipa: string
  sentence: Sentence
options: string[]
  /** 到期作答 / 提前复习 —— 提前复习不计入正确率 */
  isDue: boolean
  /** 作答后才有：这次作答后的 SRS 状态（解释区显示「下次什么时候」） */
  outcome?: ReviewOutcome
}

export interface SessionStats {
  correct: number
  wrong: number
  pending: number
  dueCorrect: number
  dueTotal: number
}

export function newSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 存活且有可用例句的义项 = 可练池。 */
export async function practicePool(): Promise<Sense[]> {
  const [senses, sents] = await Promise.all([liveSenses(), allSentences()])
  const ok = new Set<string>()
  for (const s of sents) if (!s.flagged) ok.add(s.senseId)
  return senses.filter((s) => ok.has(s.id))
}

/**
 * 闲置衰减：**组队列时顺手做一次**，把「学完就忘」这件事落地。
 *
 *  ★ 之前这个函数写好了却从没被调用 —— 于是 `rusty` 永远是 0，
 *   下一行 `if (p.mastered && !p.rusty) return` 恒成立，
 *   **一个词一旦标成「已掌握」就永远不再出现**。
 *   `srs.ts` 里的 `decayIfIdle` 与参数表里的 `DECAY_IDLE` 都是死的。
 *
 *  为什么放在「组队列」而不是「启动时全表扫」：
 *  衰减的判据是「闲置多久 vs 当前 S」，判据只在这里被用到；
 *  启动扫全表会在每次开 app 时对 8000 行做无谓的写。
 *  只有「真的超期」的行才会被写（decayIfIdle 没变化时返回原对象）。
 *
 *  ★ 为什么这里要写一层字段适配：`srs.ts` 是 `app/srs.mjs` 的逐函数移植，
 *   它内部一律 snake_case（`last_review`）；而库里存的是 camelCase
 *   （`lastReview`）。直接传 Progress 会因为字段名对不上而**永远衰减不了** ——
 *   少一次判断而已，不报错。数值口径必须留在 srs.ts 里，适配放这边。
 *
 *  事务：写 progress 必须进事务，否则 IndexedDB 直接报 NotFoundError
 *  （坑 25）；所以哪怕只改几行也要开一次事务。
 */
async function decayIdle(rows: Progress[], now: number): Promise<Progress[]> {
  const changed: Progress[] = []
  for (const p of rows) {
    const d = decayIfIdle(
      { last_review: p.lastReview, stability: p.stability, rusty: p.rusty },
      now,
    )
    if (d === undefined || d.rusty === p.rusty) continue // 没变化
    changed.push({ ...p, stability: d.stability, rusty: 1 })
  }
  if (changed.length) {
    await db.transaction('rw', db.progress, async () => {
      await db.progress.bulkPut(changed)
    })
    for (const p of changed) {
      const hit = rows.find((r) => r.senseId === p.senseId)
      if (hit) Object.assign(hit, p)
    }
  }
  return rows
}

/** 组一轮队列：到期的先来（按到期时间），再补新卡。
 *  已掌握的义项不再排期，除非它 rusty（长期不练衰减出来的）。 */
export async function buildQueue(limit = SESSION_SIZE, only?: string[]): Promise<string[]> {
  const pool = await practicePool()
  const ids = only ?? null
  const cands = ids ? pool.filter((s) => ids.includes(s.id)) : pool
  const now = Math.floor(Date.now() / 1000)
  const rows = await decayIdle(await allProgress(), now)
  const pmap = new Map<string, Progress>()
  for (const p of rows) pmap.set(p.senseId, p)

  const due: Array<{ id: string; at: number }> = []
  const fresh: string[] = []
  const pinned: string[] = []
  cands.forEach((s) => {
    const p = pmap.get(s.id)
    if (!p || p.reps === 0) {
      fresh.push(s.id)
      return
    }
    if (p.mastered && !p.rusty) return
    if (p.dueAt <= now) due.push({ id: s.id, at: p.dueAt })
  })
  due.sort((a, b) => a.at - b.at)

  // 「排进明天」的卡**排最前面**，不管它到没到期（D41 §6）。
  // 已掌握也照样进 —— 那是人自己点的「我要练它」。
  for (const s of cands) {
    const p = pmap.get(s.id)
    if (p?.pinAt && p.pinAt <= now) pinned.push(s.id)
  }

  const queue = [...pinned, ...due.map((d) => d.id).filter((id) => !pinned.includes(id)), ...fresh.filter((id) => !pinned.includes(id))]
  return queue.slice(0, limit)
}

function isDueNow(p: Progress | undefined, now: number): boolean {
  return !!p && p.reps > 0 && !p.mastered && p.dueAt <= now
}

/**
 * 按「学习状态」组队列 —— 词库页那几个分组点进来用的就是它。
 *
 *  ★ 为什么需要它：词库页原来只是台账（按仓库口径筛选），
 *    而人真正想做的是「把这一组练掉」。有了 scope，词库就能变成一个
 *    **入口**：今天到期 / 新词 / 在学，各点各练。
 *
 *  三种 scope 的定义（和词库页的分桶一一对应，改一处必须改另一处）：
 *    due      到期的（reps>0、未掌握、dueAt<=now），早到期的在前
 *    new      一次都没练过的（没有进度行或 reps=0）
 *    learning 练过但还没掌握，且**没到期** —— 「再刷一遍」那批
 */
export type QueueScope = 'due' | 'new' | 'learning'

export async function buildScopeQueue(
  scope: QueueScope,
  limit = SESSION_SIZE,
  only?: string[],
): Promise<string[]> {
  const pool = await practicePool()
  const cands = only ? pool.filter((s) => only.includes(s.id)) : pool
  const now = Math.floor(Date.now() / 1000)
  const rows = await decayIdle(await allProgress(), now)
  const pmap = new Map<string, Progress>()
  for (const p of rows) pmap.set(p.senseId, p)

  const due: Array<{ id: string; at: number }> = []
  const fresh: string[] = []
  const learning: string[] = []
  const pinned: string[] = []
  cands.forEach((s) => {
    const p = pmap.get(s.id)
    if (p?.pinAt && p.pinAt <= now) pinned.push(s.id)
    if (!p || p.reps === 0) {
      fresh.push(s.id)
      return
    }
    if (p.mastered && !p.rusty) return
    if (p.dueAt <= now) due.push({ id: s.id, at: p.dueAt })
    else learning.push(s.id)
  })
  due.sort((a, b) => a.at - b.at)
  // 「排进明天」的卡也进「今天到期」这一组 —— 它本来就该出现在今天该练的清单里
  const dueIds = [...pinned, ...due.map((d) => d.id).filter((id) => !pinned.includes(id))]
  if (scope === 'due') return dueIds.slice(0, limit)
  const q = scope === 'new' ? fresh : learning
  return shuffle(q.slice()).slice(0, limit)
}

/** 组一道题：句子随机取，选项 = 正确释义 + 3 个干扰项。
 *  干扰项优先取**同词的其他意思**（这才是真的干扰），不够再从别的词里补。
 *
 *  `pinSentence` 用来钉住**具体那一句** —— 扫读模式下用户指着屏幕上
 *  某一行说「就猜这句」，那就必须出这一句；不给的话随机到别的句子上，
 *  用户会觉得「我点的不是它」。 */
export async function makeQuestion(senseId: string, pinSentence?: number): Promise<Question | null> {
  const sense = await db.senses.get(senseId)
  if (!sense) return null
  const sents = (await db.sentences.where('senseId').equals(senseId).toArray())
    .filter((s) => !s.flagged)
  if (!sents.length) return null
  const pinned = pinSentence == null ? undefined : sents.find((s) => s.id === pinSentence)
  const p = await db.progress.get(senseId)
  const fresh = sents.filter((s) => s.id !== p?.lastSentenceId)
  const pool = fresh.length ? fresh : sents
  const sentence = pinned ?? pool[Math.floor(Math.random() * pool.length)]
  if (!sentence) return null
  const w = await db.words.get(sense.word)
  const now = Math.floor(Date.now() / 1000)

  const options = await buildOptions(sense, sense.gloss)
  return {
    sense,
    ipa: w?.ipa ?? '',
    sentence,
    options,
    isDue: isDueNow(p, now),
  }
}

/** 选项：正解 + 三个干扰项。
 *
 *  ★ 干扰项**只要求「同一个词性」**，不要求是这个词的正确意思。
 *    题目问的是「这个词在这句话里是什么意思」—— 干扰项只要词性对得上，
 *    四个选项看起来就是同一类东西，用户没法靠「这是名词释义还是动词释义」
 *    蒙对。想按词性排除 = 换了一种作弊方式。
 *
 *  ★ 同一个词的别的义项**更常被抽中**（有就优先占掉两个位）。
 *    理由：跨词的干扰项「明显不是这个词的意思」，四个字看一眼就能划掉，
 *    练不到东西；而同一个词的其它义项**都像**正确答案，只能靠「这句话
 *    到底是哪个意思」区分 —— 这才是这道题真正要练的能力。
 *    句子已经把义项钉死了，所以它们不是「第二个正确答案」，
 *    而是**贴着答案的干扰**：练的是分辨，不是二选一。
 *
 *  ★ 但干扰项**不能改**：跨词借来的，改它等于改另一张卡片；
 *    同词借来的，改它等于在你不看着的那张卡上动手。
 *    一道题的凑数选项不该有能力破坏别人的数据。 */
async function buildOptions(sense: Sense, right: string): Promise<string[]> {
  const live = await liveSenses()
  const sameWord = live.filter((s) => s.id !== sense.id && s.word === sense.word)
  const samePosSameWord = sense.pos ? sameWord.filter((s) => s.pos === sense.pos) : sameWord
  const others = live.filter(
    (s) => s.id !== sense.id && s.word !== sense.word && (!sense.pos || s.pos === sense.pos),
  )
  // 任何词性都不够时的兜底：宁可词性不齐，也不能凑不满四个选项
  const loose = live.filter((s) => s.id !== sense.id)

  const out: string[] = [right]
  const push = (g: string, cap: number): void => {
    if (g && !out.includes(g) && out.length < cap) out.push(g)
  }
  shuffle(samePosSameWord)
    .slice(0, 2)
    .forEach((s) => push(s.gloss, 4))
  shuffle(others).forEach((s) => push(s.gloss, 4))
  shuffle(loose).forEach((s) => push(s.gloss, 4))
  return shuffle(out)
}

function shuffle<T>(a: T[]): T[] {
  return a
    .map((v) => [Math.random(), v] as const)
    .sort((x, y) => x[0] - y[0])
    .map((p) => p[1])
}

/**
 * 随便练的队列：全库随机，**不看到期、不看掌握**。
 *
 *  为什么要有它：把今天的题答完之后，`buildQueue` 会返回空 ——
 *  刚答过的卡 dueAt 挪到了明天，reps>0 不再算新卡。
 *  于是「今天没事干」= 界面给不出任何事可做，人就闲着了。
 *  而「随便抽一个词的任意一句来猜」本来就是学习的一部分，
 *  只是过去没有入口。
 *
 *  ★ 提前作答仍然照常落 SRS（进度是真的推进了），但 isDue=false，
 *   所以正确率统计不受影响 —— 「提前复习不计入正确率」那条口径继续成立。
 */
export async function buildRandomQueue(limit = SESSION_SIZE, only?: string[]): Promise<string[]> {
  const pool = await practicePool()
  const cands = only ? pool.filter((s) => only.includes(s.id)) : pool
  return shuffle(cands).slice(0, limit).map((s) => s.id)
}

/** 扫读用：一次给一批句子（混词、不排序），供「点哪句猜哪句」。
 *  返回的是**句子**而不是义项 —— 扫读的最小单位就是那一行。 */
export interface ScanItem {
  sentence: Sentence
  sense: Sense
  /** 这个义项一共有几条例句 —— 扫读浮层里要说「N 句」，让人知道后面还有没有 */
  count: number
}

export async function scanBatch(
  limit = 14,
  only?: string[],
  skipWord = '',
): Promise<ScanItem[]> {
  const [pool, sents] = await Promise.all([practicePool(), allSentences()])
  const byId = new Map(pool.map((s) => [s.id, s]))
  const rows = sents.filter(
    (s) =>
      !s.flagged &&
      byId.has(s.senseId) &&
      (!only || only.includes(s.senseId)) &&
      byId.get(s.senseId)!.word !== skipWord,
  )
  // 同一个词最多连着出 1 句：报纸式浏览的乐趣在于「不断换词」，
  // 连续三行同一个词会让人觉得卡住了。
  const out: ScanItem[] = []
  const seen = new Set<string>()
  const cnt = new Map<string, number>()
  for (const s of sents) cnt.set(s.senseId, (cnt.get(s.senseId) ?? 0) + 1)
  for (const s of shuffle(rows)) {
    const sense = byId.get(s.senseId)!
    if (seen.has(sense.word) && out.length < limit) continue
    seen.add(sense.word)
    out.push({ sentence: s, sense, count: cnt.get(s.senseId) ?? 1 })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 「刷」的队列：随机但**有偏**。
 *
 *  ★ 纯随机（每条等概率）在真实词库里会变成「一直在刷待学的生词」——
 *    正在学的那些反而轮不到。所以按状态加权：
 *      到期 3 · 在学 2 · 待学 2 · 已掌握（rusty）1
 *    这仍然是随机，只是偏向「现在更该看」的那些。
 *  ★ 一个词最多出现一次：连续两张同一个词，会让人以为没刷新。
 *  ★ exclude 用来做无限加载 —— 已经刷过的词不再重复出现。
 */
export async function feedBatch(limit = 8, exclude: string[] = []): Promise<ScanItem[]> {
  const [pool, sents, prows] = await Promise.all([practicePool(), allSentences(), allProgress()])
  const byId = new Map(pool.map((s) => [s.id, s]))
  const pmap = new Map(prows.map((p) => [p.senseId, p]))
  const now = Math.floor(Date.now() / 1000)
  const skip = new Set(exclude)

  const cnt = new Map<string, number>()
  for (const s of sents) cnt.set(s.senseId, (cnt.get(s.senseId) ?? 0) + 1)

  /** 权重：到期 3、在学 2、待学 2、rusty 的已掌握 1 */
  const weightOf = (senseId: string): number => {
    const p = pmap.get(senseId)
    if (!p || p.reps === 0) return 2
    if (p.mastered) return p.rusty ? 1 : 0
    return p.dueAt <= now ? 3 : 2
  }

  const bag: Array<{ s: Sentence; w: number }> = []
  const seenWord = new Set<string>()
  for (const s of sents) {
    const sense = byId.get(s.senseId)
    if (!sense || s.flagged || skip.has(sense.word) || seenWord.has(sense.word)) continue
    const w = weightOf(s.senseId)
    if (w <= 0) continue
    seenWord.add(sense.word)
    bag.push({ s, w })
  }

  const out: ScanItem[] = []
  while (out.length < limit && bag.length) {
    // 加权抽一个（权重大的更容易被抽到），抽中即移除 —— 不重复
    const total = bag.reduce((n, b) => n + b.w, 0)
    let r = Math.random() * total
    let i = 0
    for (; i < bag.length; i++) {
      r -= bag[i].w
      if (r <= 0) break
    }
    const picked = bag[Math.min(i, bag.length - 1)]
    bag.splice(bag.indexOf(picked), 1)
    const sense = byId.get(picked.s.senseId)!
    out.push({ sentence: picked.s, sense, count: cnt.get(sense.id) ?? 1 })
  }
  return out
}

/* ── 落一次作答 ── */
export interface AnswerResult {
  outcome: ReviewOutcome
  /** 是否因此达成掌握（用于提示与庆祝） */
  justMastered: boolean
}

export async function recordAnswer(
  q: Question,
  sessionId: string,
  idx: number,
  result: 'CORRECT' | 'WRONG' | 'PENDING',
  elapsedMs: number | null,
): Promise<AnswerResult> {
  const now = Math.floor(Date.now() / 1000)
  const card = cardViewOf(q.sense, senseCount(q.sense.word))
  const prev = (await db.progress.get(q.sense.id)) ?? null
  const st = prev
    ? {
        stability: prev.stability,
        difficulty: prev.difficulty,
        reps: prev.reps,
        wrong_n: prev.wrongN,
        pending_n: prev.pendingN,
        last_review: prev.lastReview,
      }
    : { stability: 0, difficulty: 8, reps: 0, wrong_n: 0, pending_n: 0, last_review: null }

  const outcome = applyReview(st, card, result, elapsedMs, now)

  // 是否掌握：看最近 N 次有效作答的连对（03 §6）
  const recent = (
    await db.reviewLog.where('senseId').equals(q.sense.id).reverse().limit(8).toArray()
  )
    .reverse()
    .map((r) => r.result)
  const justMastered = isMastered(
    { stability: outcome.stability, reps: outcome.reps, pending_n: outcome.pendingN },
    outcome.grade >= 4 ? countStreak(recent) : 0,
    recent,
  )

  await db.transaction('rw', db.progress, db.reviewLog, async () => {
    await db.progress.put({
      senseId: q.sense.id,
      stability: outcome.stability,
      difficulty: outcome.difficulty,
      lastReview: now,
      dueAt: outcome.dueAt,
      reps: outcome.reps,
      wrongN: outcome.wrongN,
      pendingN: outcome.pendingN,
      mastered: justMastered ? 1 : 0,
      rusty: 0,
      lastSentenceId: q.sentence.id,
    })
    const log: ReviewLog = {
      sessionId,
      idx,
      senseId: q.sense.id,
      result,
      grade: outcome.grade,
      elapsedMs,
      isDue: q.isDue ? 1 : 0,
      stabilityAfter: outcome.stability,
      ts: now,
    }
    await db.reviewLog.put(log)
  })
  return { outcome, justMastered }
}

function countStreak(recent: string[]): number {
  let n = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i] !== 'CORRECT') break
    n++
  }
  return n
}

/** 手动标掌握（解释区那个按钮）：不答题直接给 mastered。 */
export async function markMastered(senseId: string): Promise<void> {
  const p = await db.progress.get(senseId)
  await db.progress.put({
    senseId,
    stability: p?.stability ?? 0,
    difficulty: p?.difficulty ?? 8,
    lastReview: p?.lastReview ?? null,
    dueAt: 0,
    reps: p?.reps ?? 0,
    wrongN: p?.wrongN ?? 0,
    pendingN: 0,
    mastered: 1,
    rusty: 0,
    lastSentenceId: p?.lastSentenceId,
  })
  toast('已标掌握，不再排期')
}

/** 标记「这句有问题」：训练时随手标，之后不再出题，等内容侧修。 */
export async function flagQuestion(q: Question, note: string): Promise<void> {
  await db.sentences.update(q.sentence.id!, { flagged: 1, flagNote: note.trim() })
  toast(note.trim() ? '已标记，备注一并给了内容侧' : '已标记，这句不再出现')
}

/** 出题时 SRS 需要的卡片视图。字段名必须与 app/srs.mjs 的 classify() 一致
 *  （is_trap / sense_id / n_senses），改名的后果是「全部判成 NEW」，
 *  起始间隔全错 —— 而且不会报错，只会悄悄变慢。 */
function cardViewOf(s: Sense, nSenses: number): SrsCard {
  return {
    is_trap: s.trap,
    tier: s.tier,
    sense_id: `s${s.slot}`,
    // n_senses 只在 >=2 时才起作用；填 0 会让多义词的首义项判成 SINGLE，
    // 与 app/srs.mjs 的起始间隔对不上。
    n_senses: nSenses,
  }
}

/**
 * 这个词有几个存活的意思 —— 直接数常驻内存的 `liveSenses`，不另建缓存。
 *
 *  ★ 之前这里有一个 `Map<string, number>` 缓存，配一个 `clearSenseCache()`
 *   —— 而那个清除函数**从来没有被调用过**（只被导出，没人用）。
 *   后果：意思页点「合并」或「拆分」之后，这个词的义项数在内存里还是老的，
 *   而它会喂给 SRS 的 `n_senses`，进而判成 SINGLE 还是 MULTI、起始间隔跟着错。
 *   不报错、不留痕，只是「新卡的起始间隔慢慢不准了」。
 *
 *   为什么缓存不是问题：`liveSenses` 本来就常驻内存（搜索、统计、词库都在用），
 *   而 senses 表的写入钩子会自动把它失效掉（db.ts 的 TABLE_CACHES）。
 *   在已缓存的数组里数一遍是毫秒级，**换来的是不可能过期**。
 *   「加一个缓存」和「加一处失效逻辑」是一笔买卖，这里不该做这笔。
 */
export function senseCount(word: string): number {
  const all = cachedNow<Sense[]>('liveSenses')
  if (!all) return 1 // 内存还没热：给个保守值，等真正作答时表早热了
  let n = 0
  for (const s of all) if (s.word === word) n++
  return n
}

export { masteryOf }