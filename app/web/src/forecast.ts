/** 复习量预测 —— 「往后 N 天，每天要复习多少」。
 *
 *  ★ 为什么不能只按 dueAt 分桶：已排程的卡越往后越少（答对一次间隔就拉长），
 *    单看存量分布会把「答完后产生的新到期」整个丢掉，90 天后期几乎全空，
 *    看起来像「以后没事了」—— 那是假轻松。所以这里做**推演**：
 *    每天把到期的卡喂给 applyReview（与真实作答同一套公式），
 *    用算出来的新 dueAt 继续往后滚。
 *
 *  ★ 口径（与用户在界面上确认的一致）：假设每天都练、每张卡都按普通速度答对
 *    （GRADE_SLOW）。这是「理想坚持下的下限」—— 真实只可能更多（答错会提前回炉），
 *    不会更少。也正因为假设固定，同一份进度算两次结果完全一样（可测）。
 *
 *  ★ 两个有意的简化，写在明处：
 *    - 天粒度：同一天内再次到期的卡滚到次日（INTERVAL_FLOOR=0.25 天，
 *      逐日推演会把一张卡在一天里刷好几次，不符合「一天练一轮」的真实用法）；
 *    - 不做闲置衰减（decayIfIdle）：本预测的前提就是「每天都在练」。
 *
 *  ★ 为什么不进 db.ts：纯函数、零 IO —— 输入进度行、输出每日数量，
 *    单测可以直接构造行来跑（tests/forecast.mjs），不用起数据库。
 */
import { applyReview, isMastered } from './srs'
import type { Progress, SrsCard, SrsState } from './types'

/** 推演用的占位卡：classify() 只在「全新卡」（reps===0）时影响结果，
 *  而推演的输入全都是已学卡（reps>0），这些字段不会被读到。 */
const DUMMY_CARD: SrsCard = { is_trap: 0, tier: 'T1', sense_id: 's1', n_senses: 1 }

/** 全对口径下，掌握判定的近期作答序列就是一串 CORRECT */
const ALL_CORRECT = ['CORRECT', 'CORRECT', 'CORRECT', 'CORRECT', 'CORRECT']

export interface ForecastResult {
  /** 每天的数量，下标 0 = 今天。按词去重（传了 wordOf）或按义项卡（没传）。 */
  counts: number[]
  /** 峰值：哪天、多少。counts 全 0 时 peakDay = -1 */
  peakDay: number
  peakCount: number
}

/**
 * 推演未来 `days` 天。
 *
 * @param rows    progress 全表（reps=0 的新卡没排期，自动忽略；已掌握的不再过）
 * @param nowSec  当前时间（秒）
 * @param wordOf  可选：senseId → word。传了按「每天有几个词要碰」计数（与首页
 *                「复习 N」的词口径一致）；不传则按义项卡计数。
 */
export function forecastDaily(
  rows: Progress[],
  nowSec: number,
  days = 90,
  wordOf?: (senseId: string) => string,
): ForecastResult {
  // 本地日界：用本地零点切天，跟用户看到的「今天」一致
  const d0 = new Date(nowSec * 1000)
  const dayStart = Math.floor(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime() / 1000)
  const dayOf = (ts: number): number => Math.floor((ts - dayStart) / 86400)

  interface Sim {
    id: string
    st: SrsState
    dueAt: number
  }

  // 入桶：到期日 <= 现在的都算今天（逾期积压）
  const buckets: Sim[][] = Array.from({ length: days }, () => [])
  for (const p of rows) {
    if (p.reps === 0 || p.mastered) continue
    const sim: Sim = {
      id: p.senseId,
      st: {
        stability: p.stability,
        difficulty: p.difficulty,
        reps: p.reps,
        wrong_n: p.wrongN,
        pending_n: p.pendingN,
        last_review: p.lastReview,
      },
      dueAt: p.dueAt,
    }
    const b = Math.max(dayOf(p.dueAt), 0) // 逾期积压算今天
    if (b >= days) continue // 到期日在窗口之外的不计入（同样不能堆进最后一天）
    buckets[b].push(sim)
  }

  const counts: number[] = Array.from({ length: days }, () => 0)

  for (let d = 0; d < days; d++) {
    const todays = buckets[d]
    buckets[d] = []
    if (!todays.length) continue

    // 按词去重：一个词当天不管几张卡到期，只算「要碰这一个词」一次
    const seenWords = new Set<string>()
    for (const sim of todays) {
      if (wordOf) {
        const w = wordOf(sim.id)
        if (w) {
          if (seenWords.has(w)) continue
          seenWords.add(w)
        }
      }
      counts[d]++

      // 答完这一次，滚出下一次到期
      const at = dayStart + d * 86400 + 12 * 3600 // 固定「中午练」，避开日界抖动
      const out = applyReview(sim.st, DUMMY_CARD, 'CORRECT', null, at)
      const st: SrsState = {
        stability: out.stability,
        difficulty: out.difficulty,
        reps: out.reps,
        wrong_n: out.wrongN,
        pending_n: out.pendingN,
        last_review: at,
      }
      if (isMastered({ stability: st.stability, reps: st.reps, pending_n: st.pending_n }, null, ALL_CORRECT)) {
        continue // 推演中掌握了，和真实规则一样不再排期
      }
      // 天粒度简化：同日再到期 → 次日；超出窗口的不计入（不能堆到最后一天充数）
      const nb = Math.max(dayOf(out.dueAt), d + 1)
      if (nb >= days) continue
      buckets[nb].push({ id: sim.id, st, dueAt: out.dueAt })
    }
  }

  let peakDay = -1
  let peakCount = 0
  for (let d = 0; d < days; d++) {
    if (counts[d] > peakCount) {
      peakCount = counts[d]
      peakDay = d
    }
  }
  return { counts, peakDay, peakCount }
}

/** 摘要行的一句话：「峰值在第 N 天，约 M 个」。全零时说明没卡。 */
export function forecastSummary(r: ForecastResult): string {
  if (r.peakDay < 0) return '未来 90 天没有排期中的复习'
  const total = r.counts.reduce((a, b) => a + b, 0)
  return `90 天共约 ${total} 次复习 · 峰值在第 ${r.peakDay + 1} 天（${r.peakCount} 个）`
}
