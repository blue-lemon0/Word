import type { Sentence } from './types'

export const SENTENCES_PER_SENSE = 5
export const MIN_SENTENCES_PER_SENSE = 2

export function usableSentenceCounts(sents: readonly Sentence[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of sents) {
    if (s.flagged) continue
    counts.set(s.senseId, (counts.get(s.senseId) ?? 0) + 1)
  }
  return counts
}

export function usableSentenceCount(sents: readonly Sentence[], senseId: string): number {
  let n = 0
  for (const s of sents) if (s.senseId === senseId && !s.flagged) n++
  return n
}

export function hasTooFewSentences(count: number): boolean {
  return count < MIN_SENTENCES_PER_SENSE
}
