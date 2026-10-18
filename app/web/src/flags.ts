/** 问题句标记 —— 背诵时随手标「这句有问题」，标了当场退出出题池。
 *
 *  闭环的另一半在内容侧：应用里标出来的句子要能变成内容侧的待修清单。
 *  浏览器端的数据在 IndexedDB 里，`content-kit/pipeline/triage_flags.py`
 *  读不到，所以这里把清单**导出成一个 JSON**，由
 *  `python content-kit/pipeline/triage_flags.py --from <file>` 接手。
 *  这一步必须存在，否则「背 → 发现问题 → 修内容」在两端断链。
 *
 *  与旧服务端那一线的一个结构差别：标记**长在句子行上**（`sentences.flagged`），
 *  没有独立的 flag 表。所以「内容侧把这句删了」= 标记自动消失；
 *  「只改了译文、原文没变」= 导入替换例句时要把标记**按原文搬过去**，
 *  否则问题句会在修复落地的那一刻悄悄消失，没人知道它修过没。
 */
import { allSentences, allSenses, db } from './db'
import type { Sense } from './types'

export interface FlagRow {
  /** 句子 id —— 关单时按它定位 */
  sentenceId: number
  senseId: string
  word: string
  slot: number
  gloss: string
  sentence: string
  note: string
}

export interface FlagsFile {
  format: 'word-flags'
  schemaVersion: 1
  exportedAt: string
  count: number
  flags: Array<{
    word: string
    slot: number
    gloss: string
    sentence: string
    note: string
  }>
}

/** 当前所有被标记的句子，按词 + 义项顺序排列（导出清单要能直接照着改） */
export async function listFlags(): Promise<FlagRow[]> {
  // 走内存缓存：错题板每次进都要这个集合，全表扫两次在手机上是几百毫秒
  const [allSents, allSenseRows] = await Promise.all([allSentences(), allSenses()])
  const sents = allSents.filter((s) => s.flagged === 1)
  const byId = new Map<string, Sense>(allSenseRows.map((s) => [s.id, s]))
  const rows: FlagRow[] = []
  for (const s of sents) {
    const sense = byId.get(s.senseId)
    if (!sense || s.id == null) continue
    rows.push({
      sentenceId: s.id!,
      senseId: s.senseId,
      word: sense.word,
      slot: sense.slot,
      gloss: sense.gloss,
      sentence: s.en,
      note: s.flagNote ?? '',
    })
  }
  return rows.sort((a, b) => a.word.localeCompare(b.word) || a.slot - b.slot)
}

/** 组出导出文件（纯函数，测试直接调它，不碰下载） */
export function buildFlagsFile(rows: FlagRow[], now = Date.now()): FlagsFile {
  return {
    format: 'word-flags',
    schemaVersion: 1,
    exportedAt: new Date(now).toISOString(),
    count: rows.length,
    flags: rows.map((r) => ({
      word: r.word,
      slot: r.slot,
      gloss: r.gloss,
      sentence: r.sentence,
      note: r.note,
    })),
  }
}

export async function downloadFlags(): Promise<string> {
  const rows = await listFlags()
  const data = buildFlagsFile(rows)
  const name = `flags_${data.exportedAt.slice(0, 10).replace(/-/g, '')}.json`
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}

/** 关单：内容侧确认修好后，用户点「已修好」清掉标记（标记随句子行，
 *  清标记就是把 flagged 归零，不动例句内容）。 */
export async function clearFlags(sentenceIds: number[]): Promise<number> {
  let n = 0
  await db.transaction('rw', db.sentences, async () => {
    for (const id of sentenceIds) {
      await db.sentences.update(id, { flagged: 0, flagNote: '' })
      n++
    }
  })
  return n
}

/** 某个义项里被标记的句子，按英文原文索引 —— 导入要替换例句时先取它 */
export async function flagIndexByText(senseId: string): Promise<Map<string, string>> {
  const rows = await db.sentences.where('senseId').equals(senseId).toArray()
  const m = new Map<string, string>()
  for (const s of rows) {
    if (s.flagged) m.set(s.en, s.flagNote ?? '')
  }
  return m
}

/** 导入替换例句后，把标记按原文搬回新写入的句子行 */
export async function reapplyFlags(senseId: string, prev: Map<string, string>): Promise<number> {
  if (prev.size === 0) return 0
  const rows = await db.sentences.where('senseId').equals(senseId).toArray()
  let n = 0
  await db.transaction('rw', db.sentences, async () => {
    for (const s of rows) {
      const note = prev.get(s.en)
      if (note !== undefined) {
        await db.sentences.update(s.id!, { flagged: 1, flagNote: note })
        n++
      }
    }
  })
  return n
}