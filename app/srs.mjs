// SRS 引擎 —— 03-记忆曲线与复习.md 的可执行版本。
//
// 公式与参数分离：参数全部读 app/config/srs_params.tsv，代码里没有魔法数。
// app/tests/verify_srs.py 是同一批公式的 Python 参考实现（黄金向量），
// app/web/tests/srs_parity.mjs 逐格比对 web 版 srs.ts 与本文件的输出。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJ = path.resolve(HERE, '..');
const PARAMS_TSV = path.join(HERE, 'config', 'srs_params.tsv');

const NUM_KEYS = new Set([
  'S0_TRAP', 'D0_TRAP', 'S0_MULTI_S1', 'D0_MULTI_S1', 'S0_SINGLE', 'D0_SINGLE',
  'S0_NEW', 'D0_NEW', 'S0_RARE', 'D0_RARE', 'S_MAX', 'S_MIN',
  'EF_A', 'EF_B', 'EF_MIN', 'GRADE_FAST', 'GRADE_SLOW', 'GRADE_PEND', 'GRADE_WRONG',
  'FAST_BASE', 'FAST_SLOPE', 'SLOW_FACTOR', 'S_PEND', 'S_WRONG', 'D_WRONG_BUMP',
  'D_DRIFT', 'INTERVAL_FLOOR', 'DECAY_IDLE_FACTOR', 'DECAY_IDLE',
  'SAME_DAY_HOURS', 'SAME_DAY_FACTOR',
  'MASTER_S', 'MASTER_REPS', 'MASTER_STREAK',
]);

export function loadParams(file = PARAMS_TSV) {
  const text = fs.readFileSync(file, 'utf8');
  const p = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, value] = line.split('\t');
    if (!key || value === undefined) continue;
    const k = key.trim();
    p[k] = NUM_KEYS.has(k) ? Number(value) : value;
  }
  for (const k of NUM_KEYS) {
    if (typeof p[k] !== 'number' || Number.isNaN(p[k])) {
      throw new Error(`srs_params.tsv 缺少或非法参数: ${k}`);
    }
  }
  return p;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 间隔因子：D 越大长得越慢。03 §4.1 */
export function easeFactor(P, D) {
  return clamp(P.EF_A - P.EF_B * (D - 1), P.EF_MIN, P.EF_A);
}

/** 快答基准时间：答对用时短于它算 GRADE_FAST，否则 GRADE_SLOW。 */
export function fastThresholdMs(P, D) {
  return P.FAST_BASE + P.FAST_SLOPE * D;
}

/**
 * 义项类型 → 初始 S0/D0（03 §3）。
 * 判据只用 bundle 里已有的字段，不额外维护一张类型表。
 */
export function classify(P, card) {
  if (card.is_trap) {
    return { kind: 'TRAP', S0: P.S0_TRAP, D0: P.D0_TRAP };
  }
  if (card.tier === 'T3' || card.tier === 'T4') {
    return { kind: 'RARE', S0: P.S0_RARE, D0: P.D0_RARE };
  }
  if (card.n_senses >= 2 && card.sense_id === 's1') {
    return { kind: 'MULTI_S1', S0: P.S0_MULTI_S1, D0: P.D0_MULTI_S1 };
  }
  if (card.n_senses === 1) {
    return { kind: 'SINGLE', S0: P.S0_SINGLE, D0: P.D0_SINGLE };
  }
  return { kind: 'NEW', S0: P.S0_NEW, D0: P.D0_NEW };
}

export function gradeFor(P, result, elapsedMs, D) {
  if (result === 'WRONG') return P.GRADE_WRONG;
  if (result === 'PENDING') return P.GRADE_PEND;
  return elapsedMs != null && elapsedMs < fastThresholdMs(P, D)
    ? P.GRADE_FAST
    : P.GRADE_SLOW;
}

/**
 * 一次作答后的新状态。
 *
 * st: { stability, difficulty, reps, wrong_n, pending_n, mastered, rusty, last_review }
 *     reps===0 视为首次曝光，用 S0/D0 起算。
 *
 * 间隔口径与 03 §4.1.1 的推演表严格一致：
 *   第 n 次答对后的间隔 = S(n-1) × ease_factor(D)
 *   第 n 次答对后的 S    = S(n-1) × (1 + ease_factor(D))
 * （verify_srs.py 的连对 4 次表就是这条：2.0 / 4.1 / 8.3 / 16.8）
 */
export function applyReview(P, st, card, result, elapsedMs, nowSec) {
  const fresh = st.reps === 0;
  const init = classify(P, card);

  let S = fresh ? init.S0 : st.stability;
  let D = fresh ? init.D0 : st.difficulty;
  if (fresh) S = clamp(S, P.S_MIN, P.S_MAX);

  const grade = gradeFor(P, result, elapsedMs, D);
  const ef = easeFactor(P, D);

  // 同日重复：收益减半（03 §7.2）
  const sameDay = !fresh && st.last_review != null &&
    nowSec - st.last_review < P.SAME_DAY_HOURS * 3600;
  const growth = sameDay ? P.SAME_DAY_FACTOR : 1;

  let intervalDays;
  if (grade === P.GRADE_FAST) {
    intervalDays = S * ef;
    S = S * (1 + ef * growth);
  } else if (grade === P.GRADE_SLOW) {
    intervalDays = S * ef * P.SLOW_FACTOR;
    S = S * (1 + ef * P.SLOW_FACTOR * growth);
  } else if (grade === P.GRADE_PEND) {
    S = S * P.S_PEND;
    intervalDays = S;
  } else {
    D += P.D_WRONG_BUMP;
    intervalDays = Math.max(P.INTERVAL_FLOOR, S * P.S_WRONG);
    S = Math.max(P.S_MIN, S * P.S_WRONG);
  }

  // 难度漂移：答得越轻松 D 越低，长得越快。
  //
  // ★ 03 §4.2 的公式写的是 D + D_DRIFT*(grade-4)，那会让「答对」把 D 推高、
  //   「答错」把 D 拉低，与该节自己的注解（"WRONG 时 D 上升，FAST 时 D 下降"）
  //   以及 §3 表里 D 越大间隔越短的前提正好相反。实现按注解取号：4 - grade。
  D = clamp(D + P.D_DRIFT * (4 - grade), 1, 10);
  S = clamp(S, P.S_MIN, P.S_MAX);
  intervalDays = Math.max(P.INTERVAL_FLOOR, intervalDays);

  const wrongN = st.wrong_n + (result === 'WRONG' ? 1 : 0);
  const pendingN = st.pending_n + (result === 'PENDING' ? 1 : 0);

  return {
    stability: S,
    difficulty: D,
    intervalDays,
    grade,
    dueAt: Math.round(nowSec + intervalDays * 86400),
    reps: st.reps + 1,
    wrong_n: wrongN,
    pending_n: pendingN,
    kind: init.kind,
    sameDay,
  };
}

/**
 * 长期不练的衰减（03 §7.1）。读取时惰性计算，不写库——
 * 避免「只是打开了一次应用」就把 S 改小。
 */
export function decayIfIdle(P, row, nowSec) {
  if (row.last_review == null || row.last_review === 0) return row;
  const gapDays = (nowSec - row.last_review) / 86400;
  if (gapDays <= P.DECAY_IDLE_FACTOR * row.stability) return row;
  return { ...row, stability: Math.max(P.S_MIN, row.stability * P.DECAY_IDLE), rusty: 1 };
}

/** 是否达标掌握（03 §6）。streak 由近 N 次有效作答给出。 */
export function isMastered(P, row, streak, recentResults) {
  if (recentResults && recentResults.slice(0, P.MASTER_STREAK)
      .some((r) => r !== 'CORRECT')) return false;
  if (streak != null && streak < P.MASTER_STREAK) return false;
  return row.stability >= P.MASTER_S &&
         row.reps >= P.MASTER_REPS &&
         row.pending_n === 0;
}

/** 会话排布权重（03 §5.2 / 02 §5）。 */
export function weight(P, row) {
  const mastery = clamp(1 - row.stability / 180, 0, 1);
  return 0.5 * row.wrong_n + 0.3 * row.is_trap + 0.2 * (1 - mastery);
}