/** 数据层 —— Dexie (IndexedDB)
 *
 *  为什么不继续用 app/state/*.db（node:sqlite）：
 *  浏览器里没有 node:sqlite，纯前端跑不起来。改用 IndexedDB，
 *  这样 PWA 离线也能用，不需要起 Node 进程。
 *
 *  schema 与 app/schema.sql 对齐，唯一的关键改动：
 *  **progress 主键从 (word, senseId='s1') 换成 senseId(UUID)**。
 *  原因见 types.ts 开头 —— 义项一重排，'s1' 就会指向另一个意思，
 *  进度会静默串到错的义项上。UUID 让插入/删除/重排都不影响已有进度。
 */
import Dexie, { type Table } from 'dexie'
import type { Word, Sense, Sentence, Progress, ReviewLog, ImportLog, Snapshot } from './types'

export class WordBankDB extends Dexie {
  words!: Table<Word, string>
  senses!: Table<Sense, string>
  sentences!: Table<Sentence, number>
  progress!: Table<Progress, string>
  reviewLog!: Table<ReviewLog, [string, number]>
  importLog!: Table<ImportLog, number>
  snapshots!: Table<Snapshot, number>

  constructor() {
    super('wordbank')
    // ★ schema 只能「追加版本」，不能就地改已发布的版本。
    //   在 version(1) 上直接加一张表，已装过旧版的用户库里就既没有这张表、
    //   代码又以为有 —— 于是所有表操作抛异常（表现为「点义项进不去」「读取失败」），
    //   而且不会报任何明显错误，只会静默地查不到东西。
    //   这是 Dexie 唯一的硬规矩，代价只是多写一段定义。
    this.version(1).stores({
      words: 'word, hidden, updatedAt',
      senses: 'id, word, [word+slot], deletedAt, needsRefine, trap, tier',
      sentences: '++id, senseId, [senseId+idx]',
      progress: 'senseId, dueAt, mastered',
      // 只增不改 —— 主键复合，按会话定位某次练习的第几张卡
      reviewLog: '[sessionId+idx], senseId, ts',
      importLog: '++id, ts, word',
    })
    // v2：导入前的自动快照，只存内容层（回滚不该把背过的也退回去）
    this.version(2).stores({
      words: 'word, hidden, updatedAt',
      senses: 'id, word, [word+slot], deletedAt, needsRefine, trap, tier',
      sentences: '++id, senseId, [senseId+idx], flagged',
      progress: 'senseId, dueAt, mastered',
      reviewLog: '[sessionId+idx], senseId, ts',
      importLog: '++id, ts, word',
      snapshots: '++id, ts',
    })
  }
}

export const db = new WordBankDB()

/** 启动自检：每张表都读一次。
 *
 *  存在的理由：schema 与已有库不一致时，Dexie 不一定报「schema mismatch」，
 *  而是让每次读写**各自**抛异常 —— 表现是「这个功能坏了」而不是
 *  「数据库坏了」，极难联想到根因。这里在启动时把问题一次暴露出来。
 *  配套的回归测试在 tests/schema_upgrade.mjs（复现「旧库 + 新代码」）。
 */
export async function verifySchema(): Promise<{ ok: boolean; error?: string }> {
  try {
    await Promise.all([
      db.words.count(),
      db.senses.count(),
      db.sentences.count(),
      db.progress.count(),
      db.reviewLog.count(),
      db.importLog.count(),
      db.snapshots.count(),
    ])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/* ── 全表读取的内存缓存 ──
 *
 *  为什么需要：热路径全都在读全表 —— 搜索每敲一个字符要一次 words、
 *  首页「换一个」要 senses + sentences、训练队列要 senses + progress、
 *  统计同理。桌面 Node 上这些是 1~100 ms，手机 WebView 上慢 5~10 倍，
 *  于是表现为「输入卡顿 / 跳转卡住」。
 *
 *  怎么失效：`db.on('storagemutated')` 精确到**表**。
 *  答题只写 progress → 只清 progress 缓存，词库/例句缓存留着；
 *  这样「答完一题立刻看下一题」不会因为缓存失效而全量重读。
 *  这也是为什么不能简单地「一写就全清」。
 */
type CacheKey = 'words' | 'senses' | 'liveSenses' | 'sentences' | 'progress'
interface Entry {
  p: Promise<unknown>
  /** 解析后的值也在手边 —— 页面**首帧**要同步读的就是它，见 cachedNow */
  v?: unknown
}
const cache = new Map<CacheKey, Entry>()

/** 缓存失效（一般由写入钩子自动触发；只在测试里手动用） */
export function invalidateCaches(): void {
  cache.clear()
}

function cached<T>(key: CacheKey, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit) return hit.p as Promise<T>
  const e: Entry = { p: undefined as unknown as Promise<unknown> }
  e.p = load().then(
    (v) => {
      e.v = v
      return v
    },
    (err) => {
      cache.delete(key) // 失败不留脏缓存，否则会一直返回同一个 rejected promise
      throw err
    },
  )
  cache.set(key, e)
  return e.p as Promise<T>
}

/**
 * **同步**取已经读进内存的表；没读过就 undefined。
 *
 *  为什么需要它：跳转时页面 mount → 渲染**第一帧** → await 读库 → 第二帧。
 * 中间那一帧渲染的是骨架屏，而骨架屏再「合理」也还是一次可见的跳变
 * （真机 screencast 抓到过：点义项后有一帧只剩一张灰条卡片，
 * 标题栏都是空的 —— 用户报的就是「闪一下别的界面」）。
 *
 *  这四张表本来就常驻内存（搜索、统计、训练队列都在用），写入钩子保证它们
 *  永远是新的。所以页面首帧直接同步取：**有值就渲染完整界面，没有才退化成
 *  骨架屏**（只有冷启动直接进二级页才会退化）。
 */
export function cachedNow<T>(key: CacheKey): T | undefined {
  return cache.get(key)?.v as T | undefined
}

/** 全部词（词库、搜索用） */
export const allWords = () => cached('words', () => db.words.toArray())
/** 全部义项（含软删除的） */
export const allSenses = () => cached('senses', () => db.senses.toArray())
/** 存活义项（界面里能看到的） */
export const liveSenses = () =>
  cached('liveSenses', () =>
    db.senses.filter((s) => s.deletedAt == null).toArray(),
  )
/** 全部例句 */
export const allSentences = () => cached('sentences', () => db.sentences.toArray())
/** 全部进度 */
export const allProgress = () => cached('progress', () => db.progress.toArray())

/**
 * 把四张常用表一次性读进内存（启动时调一次）。
 *
 * 为什么值得：跳转页面的首帧要**同步**读这些表（见 cachedNow），
 * 而哪张表热不热取决于用户之前去过哪儿 —— 于是「从词库进单词页」没例句缓存、
 * 会闪一下骨架屏，「从单词页进意思页」却不会。把这件事从「碰巧」变成「必然」。
 *
 * 真机上四张表全读约 15ms（18 词的小库）；正式库（3000 词 / 7884 义项 / 930 句）
 * 也就百来毫秒，而且不阻塞首屏：调用方 fire-and-forget 即可。
 */
export function warmTables(): Promise<unknown> {
  return Promise.all([allWords(), allSenses(), liveSenses(), allSentences(), allProgress()])
}

/* 缓存失效：**用 Table.hook（公开 API）**，不用 db.on('storagemutated')。
   后者是 Dexie 的内部事件，实测在某些环境下根本不触发 —— 缓存永不失效，
   于是「关单后标记还在」「刚导入的词搜不到」这类错会以随机方式出现，
   而且不报错、不打日志，比没有缓存还难查。
   hook 是每表公开的写入钩子，create/update/delete 都会走。
   事务回滚时也已经清过了：宁可多读一次，不要拿着过期数据答题。 */
const TABLE_CACHES: Record<string, CacheKey[]> = {
  words: ['words'],
  senses: ['senses', 'liveSenses'],
  sentences: ['sentences'],
  progress: ['progress'],
  importLog: [],
  reviewLog: [],
  snapshots: [],
}

for (const [name, table] of [
  ['words', db.words],
  ['senses', db.senses],
  ['sentences', db.sentences],
  ['progress', db.progress],
  ['reviewLog', db.reviewLog],
  ['importLog', db.importLog],
  ['snapshots', db.snapshots],
] as [string, unknown][]) {
  // Dexie 的 hook() 是重载签名（creating/updating/deleting 各一份），
  // 循环里传联合类型过不了类型检查；这里显式收成单一签名，语义不变。
  const t = table as { hook(ev: string, cb: () => void): void }
  for (const ev of ['creating', 'updating', 'deleting']) {
    t.hook(ev, () => {
      for (const k of TABLE_CACHES[name] ?? []) cache.delete(k)
    })
  }
}

/* ── 便捷读取 ── */

export async function listWords(includeHidden = false): Promise<Word[]> {
  const all = await db.words.toArray()
  return includeHidden ? all : all.filter((w) => !w.hidden)
}

/** 取一个词的存活义项，按 slot 排序 */
export async function sensesOf(word: string): Promise<Sense[]> {
  const rows = await db.senses.where('word').equals(word).toArray()
  return rows.filter((s) => s.deletedAt == null).sort((a, b) => a.slot - b.slot)
}

export async function sentencesOf(senseId: string): Promise<Sentence[]> {
  const rows = await db.sentences.where('senseId').equals(senseId).toArray()
  return rows.sort((a, b) => a.idx - b.idx)
}

/* ── 同步读（页面首帧用，见 cachedNow 的说明）──
 *
 * 全部从已缓存的全表里算，不额外查 IndexedDB。数据量：
 * 正式词库 3000 词 / 7884 义项 / 930 句，一次全表遍历是毫秒级。 */

export function sensesOfWordNow(word: string): Sense[] | undefined {
  const all = cachedNow<Sense[]>('senses')
  if (!all) return undefined
  return all.filter((s) => s.word === word && s.deletedAt == null).sort((a, b) => a.slot - b.slot)
}

/** 存活义项全表（首页抽随机卡、统计口径都要） */
export function liveSensesNow(): Sense[] | undefined {
  return cachedNow<Sense[]>('liveSenses')
}

/** 全部词（首页要靠它取音标；抽卡按词找 ipa 时不能只查一个词） */
export function allWordsNow(): Word[] | undefined {
  return cachedNow<Word[]>('words')
}

export function allProgressNow(): Progress[] | undefined {
  return cachedNow<Progress[]>('progress')
}

export function senseNow(id: string): Sense | undefined {
  return cachedNow<Sense[]>('senses')?.find((s) => s.id === id)
}

export function wordNow(word: string): Word | undefined {
  return cachedNow<Word[]>('words')?.find((w) => w.word === word)
}

export function sentencesNow(senseId: string): Sentence[] | undefined {
  const all = cachedNow<Sentence[]>('sentences')
  if (!all) return undefined
  return all.filter((s) => s.senseId === senseId).sort((a, b) => a.idx - b.idx)
}

/** 一次算好几个义项的例句条数（单词页列表要用） */
export function sentenceCountsNow(ids: string[]): Map<string, number> | undefined {
  const all = cachedNow<Sentence[]>('sentences')
  if (!all) return undefined
  const want = new Set(ids)
  const m = new Map<string, number>()
  for (const s of all) {
    if (want.has(s.senseId)) m.set(s.senseId, (m.get(s.senseId) ?? 0) + 1)
  }
  return m
}

export function progressNow(ids: string[]): Map<string, Progress> | undefined {
  const all = cachedNow<Progress[]>('progress')
  if (!all) return undefined
  const want = new Set(ids)
  const m = new Map<string, Progress>()
  for (const p of all) if (want.has(p.senseId)) m.set(p.senseId, p)
  return m
}

/** 批量取进度 —— 列表页用，避免 N+1 查询 */
export async function progressOf(senseIds: string[]): Promise<Map<string, Progress>> {
  const rows = await db.progress.bulkGet(senseIds)
  const m = new Map<string, Progress>()
  rows.forEach((p, i) => {
    if (p) m.set(senseIds[i], p)
  })
  return m
}

/* ── 词条增删改 ── */

export async function setHidden(word: string, hidden: 0 | 1): Promise<void> {
  await db.words.update(word, { hidden, updatedAt: Date.now() })
}

/** 重排义项：slots 传完整的新顺序（Sense 对象数组），id 不变 */
export async function reorderSenses(word: string, ordered: Sense[]): Promise<void> {
  await db.transaction('rw', db.senses, db.words, async () => {
    const t = Date.now()
    await Promise.all(ordered.map((s, i) => db.senses.update(s.id, { slot: i + 1, updatedAt: t })))
    await db.words.update(word, { updatedAt: t })
  })
}

/** 软删除：进度和例句都留着，只是从界面隐藏 */
export async function softDeleteSense(id: string): Promise<void> {
  await db.senses.update(id, { deletedAt: Date.now(), updatedAt: Date.now() })
}

export async function restoreSense(id: string): Promise<void> {
  await db.senses.update(id, { deletedAt: null, updatedAt: Date.now() })
}

/** 硬删除：回收站里彻底删掉，进度和例句一起没 */
export async function purgeSense(id: string): Promise<void> {
  await db.transaction('rw', db.senses, db.sentences, db.progress, async () => {
    await db.sentences.where('senseId').equals(id).delete()
    await db.progress.delete(id)
    await db.senses.delete(id)
  })
}

/** 回收站清理：软删除超过 maxAgeDays 的彻底删掉，连例句与进度一起。
 *  设计稿说「30 天可还原」—— 没有清理的话那 30 天只是句安慰话，
 *  所以启动时跑一次（见 main.ts），用户也可以在「更多」里手动清空。 */
export async function sweepTrash(maxAgeDays = 30, now = Date.now()): Promise<number> {
  const cutoff = now - maxAgeDays * 86400_000
  const rows = (await db.senses.filter((s) => s.deletedAt != null).toArray()).filter(
    (s) => (s.deletedAt ?? 0) < cutoff,
  )
  for (const s of rows) await purgeSense(s.id)
  return rows.length
}

/** 回收站清空：全部彻底删掉 */
export async function emptyTrash(): Promise<number> {
  const rows = await trashedSenses()
  for (const s of rows) await purgeSense(s.id)
  return rows.length
}

/* ── 进度 ── */

export async function ensureProgress(senseId: string): Promise<Progress> {
  const existing = await db.progress.get(senseId)
  if (existing) return existing
  const fresh: Progress = {
    senseId,
    stability: 0,
    difficulty: 8,
    lastReview: null,
    dueAt: 0,
    reps: 0,
    wrongN: 0,
    pendingN: 0,
    mastered: 0,
    rusty: 0,
  }
  await db.progress.put(fresh)
  return fresh
}

/* ── 回收站 ── */

export async function trashedSenses(): Promise<Sense[]> {
  const rows = await db.senses.filter((s) => s.deletedAt != null).toArray()
  return rows.sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
}
