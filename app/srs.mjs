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
  'EF_A', 'EF_B', 'EF_MIN', 'GRADE_CORRECT', 'GRADE_PEND', 'GRADE_WRONG',
  'OVERDUE_CREDIT', 'S_PEND', 'S_WRONG', 'D_WRONG_BUMP',
  'D_DRIFT', 'INTERVAL_FLOOR', 'DECAY_IDLE_FACTOR',
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

/** 作答结果 → 评分档。速度不再参与：答对就是答对。 */
export function gradeFor(P, result) {
  if (result === 'WRONG') return P.GRADE_WRONG;
  if (result === 'PENDING') return P.GRADE_PEND;
  return P.GRADE_CORRECT;
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
 *
 * prevDueAtSec 只用于两件事：
 *   - 没到期就答对：增长按「已等待 / 计划间隔」打折（03 §7.2）；
 *   - 逾期答对：超计划的部分只认一半，见下面的 OVERDUE_CREDIT。
 */
export function applyReview(P, st, card, result, nowSec, prevDueAtSec = null) {
  const fresh = st.reps === 0;
  const init = classify(P, card);

  let S = fresh ? init.S0 : st.stability;
  let D = fresh ? init.D0 : st.difficulty;
  if (fresh) S = clamp(S, P.S_MIN, P.S_MAX);

  const grade = gradeFor(P, result);
  const ef = easeFactor(P, D);

  // 同日重复：收益减半（03 §7.2）
  const sameDay = !fresh && st.last_review != null &&
    nowSec - st.last_review < P.SAME_DAY_HOURS * 3600;
  let growth = sameDay ? P.SAME_DAY_FACTOR : 1;

  // 提前复习折扣（2026-10-24）：成功提取的加固价值取决于「等了多久」。
  // 还没到期就答对，只拿到「已等待 / 计划间隔」比例的增长；到期才满额。
  // 没有这条，随机队列里一周内反复命中同一张卡可以满额连涨、几天速成「掌握」，
  // 从未经历长间隔考验 —— 等于允许偷懒。
  //
  // 逾期补偿（2026-10-29）：反过来，真的撑到很晚才答对，也不该白等。
  // 以「计划间隔 + 0.5 × 超出部分」作为这次成功的有效证据：
  //   计划 16 天、实际 30 天 → 有效 23 天 → 下次约 23 × (1+ef) 天。
  // 只用实际时间本身会奖励拖延（拖 3 个月答对就排 9 个月），所以超出部分折半。
  let baseS = S;
  if (!fresh && grade === P.GRADE_CORRECT && prevDueAtSec != null && st.last_review != null) {
    const scheduled = prevDueAtSec - st.last_review;
    if (scheduled > 0) {
      const actual = nowSec - st.last_review;
      if (actual < scheduled) {
        growth *= Math.min(1, Math.max(0, actual / scheduled));
      } else if (actual > scheduled) {
        const effectiveDays = (scheduled + P.OVERDUE_CREDIT * (actual - scheduled)) / 86400;
        baseS = effectiveDays * (1 + ef * growth) / ef;
      }
    }
  }

  let intervalDays;
  if (grade === P.GRADE_CORRECT) {
    intervalDays = baseS * ef;
    S = baseS * (1 + ef * growth);
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

  // 90 天封顶：超过它就算「已掌握」，不再把间隔继续吹大（03 §6）。
  intervalDays = clamp(intervalDays, P.INTERVAL_FLOOR, P.MASTER_S);

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
 *
 * 只标 rusty，不改 S：这张卡还没作答，任何结果都可能。
 * 逾期答对会按实际间隔补偿；逾期答错/不会本来就会把 S 打回去。
 * 在作答前先砍 S，等于把「其实还记得」的证据提前毁掉。
 */
export function decayIfIdle(P, row, nowSec) {
  if (row.last_review == null || row.last_review === 0) return row;
  if (row.rusty === 1) return row;
  const gapDays = (nowSec - row.last_review) / 86400;
  if (gapDays <= P.DECAY_IDLE_FACTOR * row.stability) return row;
  return { ...row, rusty: 1 };
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
