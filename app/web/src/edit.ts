/** 内容编辑 —— 增删改义项、增删改例句、合并拆分。
 *
 *  全部操作都遵守一条铁律：**`Sense.id` 永不变**。slot 是显示编号，随便重排；
 *  学习进度挂 id 上，所以这些操作一个都不会让已有熟练度错位。
 *  （这正是旧 schema 用 's1' 当主键时的缺陷，见 types.ts 开头。）
 */
import { db, ensureProgress, softDeleteSense } from './db'
import type { Sense, Sentence } from './types'

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const now = () => Date.now()

/* ── 词 ── */

/**
 * 新增一个词：建词条 + 它的第一个意思，返回那个意思的 id。
 *
 *  为什么「加词」和「加第一个意思」是同一个操作：
 *  一个没有释义的意思在���个 app 里没有意义 —— 它进不了出题池（没例句），
 *  在词库里也只是多一行空壳。而分开做就要两步、两个入口，
 *  用户会在「我明明想加个词」这件事上卡住（原来界面上**根本没有**建词路径：
 *  `db.words.put` 只出现在备份恢复与两种导入里）。
 *
 *  校验放到这儿而不是调用方：只要这个函数是唯一的建词入口，
 *  「词名为空」「词名重复」「含空格」就不会从各个按钮里漏出去。
 */
export async function addWord(raw: string, ipa = ''): Promise<{ word: string; senseId: string }> {
  const word = raw.trim().toLowerCase()
  if (!word) throw new Error('还没输入单词')
  if (!/^[a-z][a-z' -]*$/.test(word)) {
    throw new Error(`「${raw.trim()}」不像一个英文单词`)
  }
  if ((await db.words.get(word)) != null) throw new Error(`「${word}」已经在词库里了`)

  const t = now()
  const senseId = await addSense(word)
  await db.words.put({
    word,
    ipa: ipa.trim().replace(/^\/|\/$/g, ''),
    hidden: 0,
    createdAt: t,
    updatedAt: t,
  })
  return { word, senseId }
}

/* ── 义项 ── */

/** 给**已存在**的词加一个意思。词条不在的话先建出来 ——
 *  原来这里直接 `db.words.update(word, …)`，而对不存在的词它就是一次
 *  **静默 no-op**：`addSense` 照样成功，于是留下一条没有词条的孤儿意思
 *  （音标永远空、备份导出时也带不出来）。 */
export async function addSense(word: string, gloss = '', slot?: number): Promise<string> {
  const t = now()
  const rows = await db.senses.where('word').equals(word).toArray()
  const live = rows.filter((s) => s.deletedAt == null)
  // slot 给定就插在它前面，否则追加到末尾
  const at = slot ? live.filter((s) => s.slot < slot).length + 1 : live.length + 1

  const id = uuid()
  const sense: Sense = {
    id,
    word,
    slot: at,
    pos: '',
    gloss,
    glossEn: '',
    note: '',
    trap: 0,
    tier: '',
    needsRefine: 0,
    deletedAt: null,
    createdAt: t,
    updatedAt: t,
  }
  await db.transaction('rw', db.senses, db.progress, db.words, async () => {
    await db.senses.put(sense)
    await ensureProgress(id)
    // 词条不存在就先建：见函数头。`put` 对已存在的行是整体覆盖，
    // 所以先查再决定 put 还是只更新时间戳。
    const w = await db.words.get(word)
    if (!w) {
      await db.words.put({ word, ipa: '', hidden: 0, createdAt: t, updatedAt: t })
    } else {
      await db.words.update(word, { updatedAt: t })
    }
  })
  await normalizeSlots(word)
  return id
}

export async function updateSense(id: string, patch: Partial<Sense>): Promise<void> {
  await db.senses.update(id, { ...patch, updatedAt: now() })
}

/** 把某词的 slot 重排成 1..n（插入/删除/重排之后调用） */
export async function normalizeSlots(word: string): Promise<void> {
  const rows = (await db.senses.where('word').equals(word).toArray())
    .filter((s) => s.deletedAt == null)
    .sort((a, b) => a.slot - b.slot)
  const t = now()
  await db.senses.bulkUpdate(rows.map((s, i) => ({ key: s.id, changes: { slot: i + 1 } })))
  await db.words.update(word, { updatedAt: t })
}

/** 合并：drop 的例句搬到 keep 后面，学习状态两边相加取高。drop 行彻底删除
 *  （它的内容已经并进 keep，留着只会是重复卡片；回收站保留的是「误删」，
 *  合并是有明确去处的操作，不需要再留一份）。 */
export async function mergeSenses(keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) return
  // words 也在 scope 里：normalizeSlots 会顺手更新词条的 updatedAt
  await db.transaction('rw', db.words, db.senses, db.sentences, db.progress, async () => {
    const keep = await db.senses.get(keepId)
    const drop = await db.senses.get(dropId)
    if (!keep || !drop) return

    const keepSents = (await db.sentences.where('senseId').equals(keepId).toArray()).sort((a, b) => a.idx - b.idx)
    const dropSents = (await db.sentences.where('senseId').equals(dropId).toArray()).sort((a, b) => a.idx - b.idx)
    let idx = keepSents.length
    for (const s of dropSents) {
      await db.sentences.update(s.id!, { senseId: keepId, idx: idx++ })
    }

    // 保留本地释义（用户可能自己改过），只补空字段
    await db.senses.update(keepId, {
      gloss: keep.gloss || drop.gloss,
      glossEn: keep.glossEn || drop.glossEn,
      note: keep.note || drop.note,
      pos: keep.pos || drop.pos,
      trap: (keep.trap || drop.trap) as 0 | 1,
      updatedAt: now(),
    })

    const a = await db.progress.get(keepId)
    const b = await db.progress.get(dropId)
    if (a && b) {
      await db.progress.put({
        ...a,
        stability: Math.max(a.stability, b.stability),
        difficulty: (a.reps > 0 ? a.difficulty : b.difficulty) || 8,
        reps: a.reps + b.reps,
        wrongN: a.wrongN + b.wrongN,
        pendingN: a.pendingN + b.pendingN,
        mastered: (a.mastered || b.mastered) as 0 | 1,
        // 两边都在等复习时，先到期的那条先生效
        dueAt: a.dueAt && b.dueAt ? Math.min(a.dueAt, b.dueAt) : a.dueAt || b.dueAt,
        lastReview: Math.max(a.lastReview ?? 0, b.lastReview ?? 0) || null,
      })
    }
    await db.progress.delete(dropId)
    await db.senses.delete(dropId)
    await normalizeSlots(keep.word)
    if (keep.word !== drop.word) await normalizeSlots(drop.word)
  })
}

/** 拆分：把选中的例句挪到新义项上。新义项 id 是新的，进度从零开始。 */
export async function splitSense(srcId: string, gloss: string, sentenceIds: number[]): Promise<string | null> {
  const src = await db.senses.get(srcId)
  if (!src) return null
  const newId = await addSense(src.word, gloss)
  const moving = await db.sentences.bulkGet(sentenceIds)
  let idx = 0
  for (const s of moving) {
    if (!s) continue
    await db.sentences.update(s.id!, { senseId: newId, idx: idx++ })
  }
  await normalizeSlots(src.word)
  return newId
}

/** 删掉一个词的全部义项（连同例句与进度）—— 「删除这个词」按钮。 */
export async function purgeWord(word: string): Promise<void> {
  await db.transaction('rw', db.words, db.senses, db.sentences, db.progress, async () => {
    const rows = await db.senses.where('word').equals(word).toArray()
    for (const s of rows) {
      await db.sentences.where('senseId').equals(s.id).delete()
      await db.progress.delete(s.id)
    }
    await db.senses.where('word').equals(word).delete()
    await db.words.delete(word)
  })
}

/* ── 例句 ── */

function locate(text: string, form: string): { spanStart: number; spanLen: number } {
  const i = form ? text.toLowerCase().indexOf(form.toLowerCase()) : -1
  return i >= 0 ? { spanStart: i, spanLen: form.length } : { spanStart: -1, spanLen: 0 }
}

export async function addSentence(senseId: string, word: string, en: string, zh = ''): Promise<void> {
  const count = await db.sentences.where('senseId').equals(senseId).count()
  const span = locate(en, word)
  const s: Sentence = {
    senseId,
    idx: count,
    en: en.trim(),
    zh: zh.trim(),
    spanStart: span.spanStart,
    spanLen: span.spanLen,
    form: span.spanStart >= 0 ? word : '',
    clue: '',
    flagged: 0,
    flagNote: '',
  }
  await db.sentences.add(s)
}

export async function updateSentence(id: number, patch: Partial<Sentence>): Promise<void> {
  await db.sentences.update(id, patch)
}

export async function deleteSentence(id: number): Promise<void> {
  await db.sentences.delete(id)
}

/**
 * 把一条例句挪到 from → to（拖动排序落定后一次性写入）。
 *
 * 为什么不用上面那个一次一步的版本换着挪：拖 3 格就得写 6 次
 * db.update，中途刷新会把顺序刷成半成品 —— 用户看到列表闪一下、
 * 顺序还错着，最后一次失败就真的错位了。
 *
 * 这里直接把整段重排成连续 idx，一趟写完。**id 完全不动**，
 * 所以例句上挂的标记和熟练度不会跟着位置漂移。
 */
export async function reorderSentences(list: Sentence[], from: number, to: number): Promise<void> {
  const sorted = [...list].sort((a, b) => a.idx - b.idx)
  if (from < 0 || to < 0 || from >= sorted.length || to >= sorted.length || from === to) return
  const item = sorted[from]
  const rest = sorted.filter((_, i) => i !== from)
  const next = [...rest.slice(0, to), item, ...rest.slice(to)]
  // 整体平移起点，保证 idx 从 1 开始连续 —— 留着空洞会让下次排序判断错位
  const base = Math.min(...next.map((s) => s.idx)) - 1
  await db.transaction('rw', db.sentences, async () => {
    for (let i = 0; i < next.length; i++) {
      await db.sentences.update(next[i].id!, { idx: base + 1 + i })
    }
  })
}


/**
 * 重新学一个意思：把它的学习记录清零，例句和释义都留着。
 *
 *  为什么需要它：回滚快照**只回内容**（这是有意的设计 —— 导入翻车不该把
 *  背过的也退回去），所以「内容回到某个版本」和「进度回到某个版本」
 *  之间有个一直没人管的缺口。用户真正想要的是「这个词我已经会了，
 *  现在想从头再练一遍」—— 没有它就只能导入一份旧备份去覆盖，
 *  那会把所有别的词也一起退回去。
 *
 *  ★ 只写 progress，**不碰 reviewLog**：作答流水是历史（它统计正确率、
 *   支撑「已掌握」的连对判定），把流水一起删会让掌握判定凭空改变。
 *   清零之后它重新排期，连对从头数。
 *
 *  ★ 不需要手动清缓存：progress 表的写入钩子（db.ts 的 Table.hook）会自动失效。
 *   这正是坑 53 的那条判据 —— **失效钩子已经存在，就别再自己造一个**。
 */
export async function resetProgress(senseId: string): Promise<void> {
  await db.progress.put({
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
  })
}

export { softDeleteSense }
