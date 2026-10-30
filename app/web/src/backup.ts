/** 备份、快照、回滚 —— 格式见 docs/DESIGN-词库系统v2.md §4.4。
 *
 *  分层原则贯穿全文件：
 *    内容（词/义项/例句）与进度（progress）分开存。回滚只回内容，
 *    学习记录原样保留 —— 导入翻车不该把人背过的东西也退回去。
 */
import { APP_VERSION } from './app-info'
import { db } from './db'
import { uuid } from './edit'
import { exportFile } from './fileio'
import { flagIndexByText, reapplyFlags } from './flags'
import type { Sense, Sentence, Word } from './types'

const MAX_SNAPSHOTS = 10

/* ── 快照 ── */

async function dumpContent(): Promise<string> {
  const [words, senses, sentences] = await Promise.all([
    db.words.toArray(),
    db.senses.toArray(),
    db.sentences.toArray(),
  ])
  return JSON.stringify({ words, senses, sentences })
}

/** 导入/大批量改内容之前先存一份，保留最近 MAX_SNAPSHOTS 次 */
export async function snapshot(label: string): Promise<void> {
  await db.snapshots.add({ ts: Date.now(), label, payload: await dumpContent() })
  const ids = await db.snapshots.orderBy('ts').reverse().toArray()
  for (const row of ids.slice(MAX_SNAPSHOTS)) {
    if (row.id != null) await db.snapshots.delete(row.id)
  }
}

export async function listSnapshots() {
  return db.snapshots.orderBy('ts').reverse().toArray()
}

/** 回滚到某次快照：内容整体还原，进度与历史保留 */
export async function rollback(id: number): Promise<void> {
  const row = await db.snapshots.get(id)
  if (!row) throw new Error('快照不存在')
  const data = JSON.parse(row.payload) as {
    words: Word[]
    senses: Sense[]
    sentences: Sentence[]
  }
  await db.transaction('rw', db.words, db.senses, db.sentences, async () => {
    await db.words.clear()
    await db.senses.clear()
    await db.sentences.clear()
    await db.words.bulkAdd(data.words)
    await db.senses.bulkAdd(data.senses)
    // id 是自增的，回滚时保留原 id，避免与已有的进度/标记对不上
    for (const s of data.sentences) {
      const { id, ...rest } = s
      await db.sentences.add({ ...rest, id, flagNote: rest.flagNote ?? '' })
    }
  })
  // 删掉的义项对应的进度行成了孤儿，一并清掉（活着的内容层没有它们）
  const live = new Set((await db.senses.toArray()).map((s) => s.id))
  for (const p of await db.progress.toArray()) {
    if (!live.has(p.senseId)) await db.progress.delete(p.senseId)
  }
}

/* ── 导出 ── */

export interface BackupFile {
  format: string
  schemaVersion: number
  exportedAt: string
  appVersion: string
  stats: { words: number; senses: number; sentences: number; learned: number }
  words: Array<{
    word: string
    ipa: string
    hidden: 0 | 1
    senses: Array<{ sense: Sense; sentences: Sentence[] }>
  }>
  progress?: unknown[]
  reviews?: unknown[]
  imports?: unknown[]
}

export async function buildBackup(includeProgress = true): Promise<BackupFile> {
  const [words, senses, sentences, progress, reviews, imports] = await Promise.all([
    db.words.toArray(),
    db.senses.toArray(),
    db.sentences.toArray(),
    db.progress.toArray(),
    db.reviewLog.toArray(),
    db.importLog.toArray(),
  ])
  const bySense = new Map<string, Sentence[]>()
  for (const s of sentences) {
    const arr = bySense.get(s.senseId)
    if (arr) arr.push(s)
    else bySense.set(s.senseId, [s])
  }
  const byWord = new Map<string, Sense[]>()
  for (const s of senses) {
    const arr = byWord.get(s.word)
    if (arr) arr.push(s)
    else byWord.set(s.word, [s])
  }
  const learned = new Set(progress.filter((p) => p.reps > 0).map((p) => p.senseId))

  return {
    format: 'word.backup',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    stats: {
      words: words.length,
      senses: senses.length,
      sentences: sentences.length,
      learned: learned.size,
    },
    words: words
      .slice()
      .sort((a, b) => a.word.localeCompare(b.word))
      .map((w) => ({
        word: w.word,
        ipa: w.ipa,
        hidden: w.hidden,
        senses: (byWord.get(w.word) ?? [])
          .slice()
          .sort((a, b) => a.slot - b.slot)
          .map((sense) => ({
            sense,
            sentences: (bySense.get(sense.id) ?? []).slice().sort((a, b) => a.idx - b.idx),
          })),
      })),
    progress: includeProgress ? progress : undefined,
    reviews: includeProgress ? reviews : undefined,
    imports,
  }
}

/**
 * 导出备份 —— 走 fileio 的分享优先策略。
 *
 * 原来这里直接 `<a download>`。手机上那玩意可能什么都不发生，
 * 也可能存进一个用户找不到的目录，于是备份只能「导出完自己去捞」，
 * 而备份最该有的用法就是随手发到微信/QQ 存进聊天记录。
 *
 * 文件名原来是 `wordbank_20261018072.vwbak`：一是长，二是 `.vwbak` 这个
 * 后缀系统不认识 —— 存到「文件」App 里既不在 JSON 分类下、也点不开，
 * 再导入时用户根本找不到它。现在改成 `.json`（内容本来就是 JSON），
 * 名字短到一眼能认：词库备份_2026-10-18.json。
 */
export async function downloadBackup(includeProgress = true): Promise<string> {
  const data = await buildBackup(includeProgress)
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const name = `词库备份_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
  const r = await exportFile(data, name, '词库备份')
  if (r.outcome === 'failed') throw new Error('导出失败')
  return name
}

/**
 * 一条导入记录压成一行，给「导入历史」列表用。
 *
 *  ⚠ 存下来的 summary 有**两种格式**，各说各的，认错就会把话说没了：
 *    - 内容包批量导入（import.ts）：`词+18 义+66 改0 句+33 冲突0` —— 给程序看的口径
 *    - AI 单词导入（importer.ts）：`新增义项2 例句10` —— 本来就是人话
 *  早先只按第一种解析，第二种一个词都匹配不上，于是列表里那条只剩一个光秃秃的
 *  词名 —— 不报错、不留痕，只是「说得比原来少了」（坑 47）。
 *
 *  所以：**认得出才翻译，认不出就原样用**。不要对已经是人话的句子再翻译一遍。
 */
export function importLine(r: { ts: number; word: string; summary: string }): string {
  const words = r.word.split(',').filter(Boolean)
  const parts: string[] = []
  if (words.length === 1) parts.push(words[0])
  else if (words.length > 1) parts.push(`${words.length} 个词`)

  if (/^(词|义|句|改|冲突)\+?\d+/.test(r.summary)) {
    // ⚠ 加号是可选的，而且是**必须可选**：
    // 实际存下来的口径是 `词+18 义+66 改0 句+33 冲突0` ——
    // 只有前三项带加号，「改」和「冲突」后面直接跟数字（见 import.ts 的 summary）。
    // 按 `key+N` 一刀切，这两个永远匹配不上，于是列表里少了两项信息，
    // 而且完全静默。这个 bug 就是 flow_smoke 里那三条断言逮到的。
    for (const [key, label] of [
      ['词', '词'],
      ['义', '义项'],
      ['句', '句'],
      ['改', '改'],
      ['冲突', '冲突'],
    ] as const) {
      const m = new RegExp(`${key}\\+?(\\d+)`).exec(r.summary)
      const n = m ? Number(m[1]) : 0
      if (!n) continue // 恒为 0 的项不占位置
      if (key === '词' && words.length > 1) continue // 上面已经说了「N 个词」
      parts.push(`${n} ${label}`)
    }
  } else {
    parts.push(r.summary)
  }
  return parts.join(' · ') || '无变化'
}

/* ── 导入备份 ── */

export interface RestoreResult {
  words: number
  senses: number
  sentences: number
  progress: number
  reviews: number
  skipped: string[]
}

/** 恢复备份：内容按 id 覆盖（备份里 id 就是真相），进度按 id UPSERT，
 *  作答流水按 (sessionId, idx) 幂等去重 —— 重复导入同一个文件不会翻倍。 */
export async function restoreBackup(json: unknown): Promise<RestoreResult> {
  const res: RestoreResult = { words: 0, senses: 0, sentences: 0, progress: 0, reviews: 0, skipped: [] }
  const f = json as Partial<BackupFile>
  if (!f || f.format !== 'word.backup') {
    res.skipped.push('不是 word.backup 文件')
    return res
  }
  if (!Array.isArray(f.words)) {
    res.skipped.push('文件里没有 words 数组')
    return res
  }
  await snapshot('恢复备份前')

  await db.transaction(
    'rw',
    db.words,
    db.senses,
    db.sentences,
    db.progress,
    db.reviewLog,
    async () => {
      for (const w of f.words!) {
        await db.words.put({
          word: w.word,
          ipa: w.ipa ?? '',
          hidden: w.hidden ?? 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        res.words++
        for (const row of w.senses ?? []) {
          const s = row.sense
          if (!s || !s.id || !s.gloss) {
            res.skipped.push(`${w.word}: 有义项缺 id 或 gloss`)
            continue
          }
          await db.senses.put({ ...s, word: w.word, deletedAt: s.deletedAt ?? null })
          res.senses++
          const prevFlags = await flagIndexByText(s.id)
          const olds = await db.sentences.where('senseId').equals(s.id).toArray()
          for (const o of olds) await db.sentences.delete(o.id!)
          for (const sent of row.sentences ?? []) {
            const { id, ...rest } = sent
            await db.sentences.add({ ...rest, senseId: s.id, flagNote: rest.flagNote ?? '' })
            res.sentences++
          }
          // 标记按原文搬到新写入的行上（备份是「真相」，不该顺手把标记清掉）
          await reapplyFlags(s.id, prevFlags)
        }
      }
      for (const p of (f.progress ?? []) as Array<Record<string, unknown>>) {
        const sid = p.senseId as string
        if (!sid || !(await db.senses.get(sid))) continue // 锚点悬空，跳过
        await db.progress.put(p as never)
        res.progress++
      }
      for (const r of (f.reviews ?? []) as Array<Record<string, unknown>>) {
        await db.reviewLog.put(r as never)
        res.reviews++
      }
    },
  )
  await db.importLog.add({
    ts: Date.now(),
    word: `${res.words} 词`,
    source: '备份恢复',
    summary: `词${res.words} 义${res.senses} 句${res.sentences} 进度${res.progress} 流水${res.reviews}`,
  })
  return res
}

/** 首次打开还没有任何内容时，把种子灌进去之前先存一份空快照也没意义，
 *  这里只保证 id 生成走同一条路（避免两处各写一份 uuid）。 */
export { uuid }