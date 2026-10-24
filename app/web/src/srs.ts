/** SRS —— 从 app/srs.mjs 逐函数移植，公式与参数一字不改。
 *
 *  为什么不重新实现：`srs.mjs` 是 `app/tests/verify_srs.py` 的参照对象，
 *  两边比对黄金向量；`app/state/*.db` 里的历史进度是按这套公式算出来的。
 *  移植版必须与它**数值完全一致**，否则旧进度接不上、复习间隔会突变。
 *
 *  与原版的唯一差别：原来 `loadParams()` 读 TSV 文件，这里改成 import JSON
 *  （构建期由 scripts/params2json.py 从同一份 TSV 生成，见文件头注释）。
 *  计算逻辑一行没动。
 */
import P from './srs_params.json'
import type { SrsCard, SrsState } from './types'

export const PARAMS = P as Record<string, number>

/** 间隔因子：D 越大长得越慢。03 §4.1 */
export function easeFactor(D: number): number {
  return clamp(P.EF_A - P.EF_B * (D - 1), P.EF_MIN, P.EF_A)
}

/** 快答基准时间：答对用时短于它算 GRADE_FAST，否则 GRADE_SLOW。 */
export function fastThresholdMs(D: number): number {
  return P.FAST_BASE + P.FAST_SLOPE * D
}

/** 义项类型 → 初始 S0/D0（03 §3）。判据只用卡片已有字段。 */
export function classify(card: SrsCard): { kind: string; S0: number; D0: number } {
  if (card.is_trap) return { kind: 'TRAP', S0: P.S0_TRAP, D0: P.D0_TRAP }
  if (card.tier === 'T3' || card.tier === 'T4') {
    return { kind: 'RARE', S0: P.S0_RARE, D0: P.D0_RARE }
  }
  if (card.n_senses >= 2 && card.sense_id === 's1') {
    return { kind: 'MULTI_S1', S0: P.S0_MULTI_S1, D0: P.D0_MULTI_S1 }
  }
  if (card.n_senses === 1) return { kind: 'SINGLE', S0: P.S0_SINGLE, D0: P.D0_SINGLE }
  return { kind: 'NEW', S0: P.S0_NEW, D0: P.D0_NEW }
}

export function gradeFor(
  result: 'CORRECT' | 'WRONG' | 'PENDING',
  elapsedMs: number | null,
  D: number,
): number {
  if (result === 'WRONG') return P.GRADE_WRONG
  if (result === 'PENDING') return P.GRADE_PEND
  return elapsedMs != null && elapsedMs < fastThresholdMs(D) ? P.GRADE_FAST : P.GRADE_SLOW
}

export interface ReviewOutcome {
  stability: number
  difficulty: number
  intervalDays: number
  grade: number
  dueAt: number
  reps: number
  wrongN: number
  pendingN: number
  kind: string
  sameDay: boolean
}

/** 一次作答后的新状态。
 *  间隔口径与 03 §4.1.1 的推演表严格一致：
 *    第 n 次答对后的间隔 = S(n-1) × ease_factor(D)
 *    第 n 次答对后的 S    = S(n-1) × (1 + ease_factor(D))
 *  （verify_srs.py 的连对 4 次表就是这条：2.0 / 4.1 / 8.3 / 16.8）
 */
export function applyReview(
  st: SrsState,
  card: SrsCard,
  result: 'CORRECT' | 'WRONG' | 'PENDING',
  elapsedMs: number | null,
  nowSec: number,
  prevDueAtSec: number | null = null,
): ReviewOutcome {
  const fresh = st.reps === 0
  const init = classify(card)

  let S = fresh ? init.S0 : st.stability
  let D = fresh ? init.D0 : st.difficulty
  if (fresh) S = clamp(S, P.S_MIN, P.S_MAX)

  const grade = gradeFor(result, elapsedMs, D)
  const ef = easeFactor(D)

  // 同日重复：收益减半（03 §7.2）
  const sameDay =
    !fresh && st.last_review != null && nowSec - st.last_review < P.SAME_DAY_HOURS * 3600
  let growth = sameDay ? P.SAME_DAY_FACTOR : 1

  // 提前复习折扣（2026-10-24）：成功提取的加固价值取决于「等了多久」。
  // 还没到期就答对，只拿到「已等待 / 计划间隔」比例的增长；到期或逾期才满额。
  // 没有这条，随机队列里一周内反复命中同一张卡可以满额连涨、几天速成「掌握」，
  // 从未经历长间隔考验 —— 等于允许偷懒。
  if (!fresh && result === 'CORRECT' && prevDueAtSec != null && st.last_review != null) {
    const scheduled = prevDueAtSec - st.last_review
    if (nowSec < prevDueAtSec && scheduled > 0) {
      growth *= Math.min(1, Math.max(0, (nowSec - st.last_review) / scheduled))
    }
  }

  let intervalDays: number
  if (grade === P.GRADE_FAST) {
    intervalDays = S * ef
    S = S * (1 + ef * growth)
  } else if (grade === P.GRADE_SLOW) {
    intervalDays = S * ef * P.SLOW_FACTOR
    S = S * (1 + ef * P.SLOW_FACTOR * growth)
  } else if (grade === P.GRADE_PEND) {
    S = S * P.S_PEND
    intervalDays = S
  } else {
    D += P.D_WRONG_BUMP
    intervalDays = Math.max(P.INTERVAL_FLOOR, S * P.S_WRONG)
    S = Math.max(P.S_MIN, S * P.S_WRONG)
  }

  // 难度漂移：答得越轻松 D 越低，长得越快。
  // ★ 03 §4.2 的公式写的是 D + D_DRIFT*(grade-4)，那会让「答对」把 D 推高、
  //   「答错」把 D 拉低，与该节自己的注解（"WRONG 时 D 上升，FAST 时 D 下降"）
  //   以及 §3 表里 D 越大间隔越短的前提正好相反。实现按注解取号：4 - grade。
  D = clamp(D + P.D_DRIFT * (4 - grade), 1, 10)
  S = clamp(S, P.S_MIN, P.S_MAX)
  intervalDays = Math.max(P.INTERVAL_FLOOR, intervalDays)

  return {
    stability: S,
    difficulty: D,
    intervalDays,
    grade,
    dueAt: Math.round(nowSec + intervalDays * 86400),
    reps: st.reps + 1,
    wrongN: st.wrong_n + (result === 'WRONG' ? 1 : 0),
    pendingN: st.pending_n + (result === 'PENDING' ? 1 : 0),
    kind: init.kind,
    sameDay,
  }
}

/** 长期不练的衰减（03 §7.1）。读取时惰性计算，不写库 ——
 *  避免「只是打开了一次应用」就把 S 改小。
 */
export function decayIfIdle<T extends { last_review: number | null; stability: number; rusty: number }>(
  row: T,
  nowSec: number,
): T {
  if (row.last_review == null || row.last_review === 0) return row
  const gapDays = (nowSec - row.last_review) / 86400
  if (gapDays <= P.DECAY_IDLE_FACTOR * row.stability) return row
  return { ...row, stability: Math.max(P.S_MIN, row.stability * P.DECAY_IDLE), rusty: 1 }
}

/** 是否达标掌握（03 §6）。streak 由近 N 次有效作答给出。 */
export function isMastered(
  row: { stability: number; reps: number; pending_n: number },
  streak: number | null,
  recentResults?: string[],
): boolean {
  if (recentResults && recentResults.slice(0, P.MASTER_STREAK).some((r) => r !== 'CORRECT')) {
    return false
  }
  if (streak != null && streak < P.MASTER_STREAK) return false
  return row.stability >= P.MASTER_S && row.reps >= P.MASTER_REPS && row.pending_n === 0
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
