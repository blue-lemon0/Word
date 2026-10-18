/** 两条导入路径共用的**写入原语**。
 *
 *  为什么要这个文件：导入有两条路 —— 内容包批量（`import.ts` 的 importBundle，
 *  「只加不改」）和 AI 单词逐条决策（`importer.ts` 的 applyPlan，
 *  「按用户的选择写」）。它们的**策略**确实该不同，但底层要写的东西
 *  是一模一样的：建词条、建义项、建例句、记导入历史。
 *
 *  两套实现各写一遍的后果不是「多 200 行」，而是**已经开始漂移**：
 *   · 只有 importBundle 会记 importLog，且它记得在事务里（import.ts 里
 *     有注释说明为什么必须在事务内）—— applyPlan 记在事务**外面**
 *   · 只有 restoreBackup 和 applyPlan 会存快照，importBundle 不存（已修）
 *   · 例句的 span 计算抄了两份；`Progress` 的十字段结构抄了两份
 *     （db.ts 里明明已经有 `ensureProgress`）
 *   · summary 两种格式，于是列表里少说过话（坑 47）
 *
 *  抽原语不是为了「代码变短」，是为了**下次改只改一处**。
 *  策略（要不要覆盖、冲突怎么办、要不要删）留在各自的文件里 ——
 *  那部分是真的不一样，强行合并反而会引入一个谁都不想要的第三种语义。
 *
 *  ⚠ 唯一的硬规矩：**`logImport` 必须在 `runImportTx` 的事务里调**。
 *    IndexedDB 里事务外的写不是「慢一点」，是对象库不在 scope 里直接报错
 *    （坑 25），而且错法在异步链上很难归位。
 */
import { db, ensureProgress } from './db'
import type { ImportLog, Progress, Sense, Sentence } from './types'

/** 导入要写的全部表。少一张就会在事务里报 scope 错误（坑 25）。 */
const TABLES = [db.words, db.senses, db.sentences, db.progress, db.importLog] as const

/** 开一次导入事务（含 importLog，所以日志与内容同生共死）。 */
export function runImportTx(fn: () => Promise<void>): Promise<void> {
  return db.transaction('rw', ...TABLES, fn)
}

/** 一个空的学习进度。**不要手写这十个字段** —— 用 `freshProgress`。 */
export function freshProgress(senseId: string): Progress {
  return {
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
}

/**
 * 确保词条存在，返回它现在的音标。
 *  `overwriteIpa=false` 时只补空缺 —— 内容包是权威但也不该覆盖用户手打的音标。
 */
export async function ensureWordRow(
  word: string,
  ipa: string,
  t: number,
  overwriteIpa = false,
): Promise<string> {
  const w = await db.words.get(word)
  if (!w) {
    await db.words.put({ word, ipa, hidden: 0, createdAt: t, updatedAt: t })
    return ipa
  }
  if (ipa && (overwriteIpa || !w.ipa)) {
    await db.words.update(word, { ipa, updatedAt: t })
    return ipa
  }
  return w.ipa ?? ''
}

/** 建一个义项并顺带建好它的学习记录（两者必须同生共死，否则会出没进度的孤儿）。 */
export async function createSenseRow(s: Sense): Promise<void> {
  await db.senses.put(s)
  await ensureProgress(s.id)
}

/** 在文本里定位目标词 —— 例句高亮靠它。
 *  管道给了 spanStart 就用它，AI 常常漏掉这个字段，就在文本里再找一遍。 */
export function locateSpan(text: string, form: string): { spanStart: number; spanLen: number } {
  if (!form) return { spanStart: -1, spanLen: 0 }
  const i = text.toLowerCase().indexOf(form.toLowerCase())
  return i >= 0 ? { spanStart: i, spanLen: form.length } : { spanStart: -1, spanLen: 0 }
}

/** 写一条例句：字段缺失一律当空串，flag 恒为未标记（标记是用户动作，不来自文件）。 */
export async function addSentenceRow(row: Omit<Sentence, 'id'>): Promise<void> {
  await db.sentences.add({ ...row, flagNote: row.flagNote ?? '' })
}

/**
 * 记一条导入历史。
 * ⚠ 只能在 `runImportTx` 里面调（见文件头）。
 * summary 的口径两种（「词+N 义+N …」与「新增义项N 例句N」都要认，
 * 见 `backup.ts` 的 importLine）—— 写的时候保持各自的形状，
 * **不要**为了好看强行统一，读的那边要同时认得两种（坑 47）。
 */
export async function logImport(log: Omit<ImportLog, 'id'>): Promise<void> {
  await db.importLog.add(log)
}