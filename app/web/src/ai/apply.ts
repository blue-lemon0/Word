/** 把「提案」落成真实的库改动。
 *
 *  ★ AI 永远不直接写库：它只产出提案，写库只走这里 —— 而这里用的都是
 *    已有的编辑原语（`edit.updateSense` / `edit.addSentence` / …），
 *    也就是说 AI 改内容的能力**不超过手点界面能做的范围**。
 *    这条边界是刻意的：出问题时，用户手改一次就能覆盖它。
 *
 *  ★ 批量应用之前先打一张内容层快照：AI 一次改好几条时，
 *    人不可能逐条回滚。快照只含内容（词/义项/例句），不碰学习进度。
 */
import { snapshot } from '../backup'
import { db } from '../db'
import type { Sense } from '../types'
import {
  addSentence as addSentenceEdit,
  addSense,
  replaceSentence as replaceSentenceEdit,
  updateSense,
  updateWord,
} from '../edit'
import type { Proposal } from './types'

/** 应用一条提案。返回给人看的一句话（用于 toast / 界面回执）。 */
export async function applyOne(p: Proposal): Promise<string> {
  switch (p.kind) {
    case 'sense.update': {
      const patch: Partial<Record<string, string | number>> = {}
      if (p.gloss != null) patch.gloss = p.gloss
      if (p.pos != null) patch.pos = p.pos
      if (p.note != null) patch.note = p.note
      if (p.glossEn != null) patch.glossEn = p.glossEn
      if (p.trap != null) patch.trap = p.trap
      // ★ 补上释义就等于「不再是空壳」：needsRefine 是「占位义项待补」的标记
      //   （D37 顺手加入时打的）。改写释义却不摘掉它，词库里会一直挂着「需精修」，
      //   而人已经补完了 —— 那个筛选结果就变成噪音。
      if (p.gloss != null && p.gloss.trim()) patch.needsRefine = 0
      await updateSense(p.senseId, patch as Partial<Sense>)
      for (const s of p.sentences ?? []) {
        await addSentenceEdit(p.senseId, p.word, s.en, s.zh ?? '', s.marks)
      }
      const n = p.sentences?.length ?? 0
      return `改了 s${p.slot} 的释义${n ? `，补了 ${n} 句例句` : ''}`
    }
    case 'sentence.replace': {
      await replaceSentenceEdit(p.sentenceId, p.en, p.zh, p.marks)
      return '换了一条例句'
    }
    case 'word.update': {
      if (p.ipa) await updateWord(p.word, { ipa: p.ipa })
      return `补了音标：/${p.ipa}/`
    }
    case 'sentence.add': {
      const sense = await db.senses.get(p.senseId)
      if (!sense) throw new Error('义项不存在')
      await addSentenceEdit(p.senseId, sense.word, p.en, p.zh ?? '', p.marks)
      return `给 s${sense.slot} 补了一句`
    }
    case 'sense.add': {
      const id = await addSense(p.word, p.gloss)
      if (p.pos) await updateSense(id, { pos: p.pos })
      // 新义项自带的例句：现在它才有 id，能挂上去了
      for (const s of p.sentences ?? []) {
        await addSentenceEdit(id, p.word, s.en, s.zh ?? '', s.marks)
      }
      const n = p.sentences?.length ?? 0
      return `新增了义项：${p.gloss}${n ? `（含 ${n} 句例句）` : ''}`
    }
  }
}

/**
 * 批量应用。**先打快照再动手**：中途失败时至少能整批退回去，
 * 而不是留下「改了一半」的库。
 */
export async function applyAll(ps: Proposal[]): Promise<{ applied: number; label: string }> {
  if (!ps.length) return { applied: 0, label: '' }
  const label = `AI 应用前（${ps.length} 条）`
  await snapshot(label)
  let n = 0
  for (const p of ps) {
    await applyOne(p)
    n++
  }
  return { applied: n, label }
}
