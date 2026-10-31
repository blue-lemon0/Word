/** 首页数据 —— 搜索、随机词、统计
 *
 *  首页不显示中文释义（用户定的），所以这里的查询只取英文和拼写。
 */
import { computed, ref, watch } from 'vue'
import {
  allProgress,
  allProgressNow,
  allSentences,
  allWords,
  allWordsNow,
  cachedNow,
  db,
  liveSenses,
  liveSensesNow,
  progressOf,
  sensesOf,
} from './db'
import type { Progress, Sense, Sentence, Word } from './types'
import { masteryOf } from './types'

export function useSearch() {
  const q = ref('')
  const hits = ref<Word[]>([])
  const open = ref(false)

  /* 边输入边匹配：前缀命中排最前，其次包含匹配，其余不显示。
     词库只有几千词，全表扫一遍比维护前缀索引更简单也够快 ——
     而且词表走内存缓存（见 db.ts），这里不再碰 IndexedDB。 */
  const needle = computed(() => q.value.trim().toLowerCase())

  let seq = 0
  watch(needle, async (s) => {
    const my = ++seq
    if (!s) {
      hits.value = []
      open.value = false
      return
    }
    const all = await allWords()
    if (my !== seq) return // 有更新的输入了，丢弃这次结果
    const prefix: Word[] = []
    const inner: Word[] = []
    for (const w of all) {
      const lw = w.word.toLowerCase()
      if (lw.startsWith(s)) prefix.push(w)
      else if (lw.includes(s)) inner.push(w)
    }
    prefix.sort((a, b) => a.word.length - b.word.length)
    hits.value = [...prefix, ...inner].slice(0, 12)
    open.value = hits.value.length > 0
  })

  function close() {
    open.value = false
  }

  return { q, hits, open, close }
}

/** 随机抽一个「有例句的义项」—— 首页要显示例句 */
export interface Card {
  senseId: string
  word: string
  ipa: string
  slot: number
  nSenses: number
  sentence: Sentence
}

/** 抽卡与统计的**纯算法**：输入是三张全表，输出是结果。
 *
 *  拆出来是因为要同时有同步版和异步版（首页首帧，见 db.ts 的 cachedNow）：
 *  两份实现各写一遍，迟早算出两个不一样的数字。 */
function pickCard(
  senses: Sense[],
  sentRows: Sentence[],
  words: Word[],
): Card | null {
  if (!senses.length) return null

  const bySense = new Map<string, Sentence[]>()
  for (const s of sentRows) {
    if (s.flagged) continue
    const arr = bySense.get(s.senseId)
    if (arr) arr.push(s)
    else bySense.set(s.senseId, [s])
  }

  const hidden = new Set(words.filter((w) => w.hidden).map((w) => w.word))
  const usable = senses.filter(
    (s) => !hidden.has(s.word) && (bySense.get(s.id)?.length ?? 0) > 0,
  )
  if (!usable.length) return null

  const sense = usable[Math.floor(Math.random() * usable.length)]
  const pool = bySense.get(sense.id)!
  const sentence = pool[Math.floor(Math.random() * pool.length)]
  const ipa = words.find((w) => w.word === sense.word)?.ipa ?? ''

  return {
    senseId: sense.id,
    word: sense.word,
    ipa,
    slot: sense.slot,
    nSenses: senses.filter((s) => s.word === sense.word).length,
    sentence,
  }
}

export async function randomCardWithSentence(): Promise<Card | null> {
  return pickCard(await liveSenses(), await allSentences(), await allWords())
}

/** 首帧同步抽卡。表还没热就返回 undefined —— 那是「还没读」，**不是「词库是空的」**。 */
export function randomCardNow(): Card | null | undefined {
  const senses = liveSensesNow()
  const sentRows = cachedNow<Sentence[]>('sentences')
  const words = allWordsNow()
  if (!senses || !sentRows || !words) return undefined
  return pickCard(senses, sentRows, words)
}

export interface Stats {
  words: number
  senses: number
  due: number
  mastered: number
  noSentence: number
}

export async function loadStats(): Promise<Stats> {
  return computeStats(await liveSenses(), await allProgress(), await allSentences())
}

/** 统计口径的纯算法，与 loadStats 共用一份（理由同 pickCard） */
function computeStats(senses: Sense[], progRows: Progress[], sentRows: Sentence[]): Stats {
  const pmap = new Map<string, Progress>()
  for (const p of progRows) pmap.set(p.senseId, p)
  const now = Math.floor(Date.now() / 1000)

  const hasSentence = new Set(sentRows.filter((s) => !s.flagged).map((s) => s.senseId))

  let due = 0
  let mastered = 0
  let noSentence = 0
  for (const s of senses) {
    const p = pmap.get(s.id)
    if (p && p.reps > 0 && p.dueAt <= now) due++
    if (p?.mastered) mastered++
    if (!hasSentence.has(s.id)) noSentence++
  }

  return {
    words: new Set(senses.map((s) => s.word)).size,
    senses: senses.length,
    due,
    mastered,
    noSentence,
  }
}

/** 首帧同步统计。表没热返回 undefined，别拿 0 顶上去 —— 「0 题到期」也是假数。 */
export function loadStatsNow(): Stats | undefined {
  const senses = liveSensesNow()
  const prog = allProgressNow()
  const sentRows = cachedNow<Sentence[]>('sentences')
  if (!senses || !prog || !sentRows) return undefined
  return computeStats(senses, prog, sentRows)
}

/** 某个词的全部义项 + 进度，词库/单词页都要用 */
export async function loadWord(
  word: string,
): Promise<{ word: Word | undefined; senses: Sense[]; prog: Map<string, Progress> }> {
  const w = await db.words.get(word)
  const senses = await sensesOf(word)
  const prog = await progressOf(senses.map((s) => s.id))
  return { word: w, senses, prog }
}

/* ── 展示口径的小工具（多处复用，判定标准只能有一处）── */

/** 距下次复习还有多久。要的是「隔多久」，不是「今天 / 明天」这种日历标签。
 *  < 1 小时按分钟、< 1 天按小时，其余按天；一律保留一位小数。 */
export function durationText(seconds: number): string {
  const s = Math.max(0, seconds)
  if (s < 3600) return `约 ${(s / 60).toFixed(1)} 分钟后`
  if (s < 86400) return `约 ${(s / 3600).toFixed(1)} 小时后`
  return `${(s / 86400).toFixed(1)} 天后`
}

/** 以 dueAt 时间戳算相对时长；now 可注入，便于测试。 */
export function dueInText(dueAt: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  return durationText(dueAt - nowSec)
}

/** 下次复习时间的说法：未开始 / 已掌握 / 已到期，其余给具体时长。 */
export function dueText(p?: Progress): string {
  if (!p || p.reps === 0) return '未开始'
  if (p.mastered) return '已掌握'
  const now = Math.floor(Date.now() / 1000)
  if (p.dueAt <= now) return '已到期'
  return dueInText(p.dueAt, now)
}

export function repsText(p?: Progress): string {
  if (!p || p.reps === 0) return '0 次'
  return `${p.reps} 次`
}

export { masteryOf }
