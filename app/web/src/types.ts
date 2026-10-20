/** 数据模型 —— 全部字段与 app/schema.sql 及 docs/DESIGN-词库系统v2.md §4.1 对齐。
 *
 *  核心约束：`Sense.id` 是内部 UUID，**永不变**；`Sense.slot` 只是显示编号。
 *  学习进度挂 `Sense.id`，所以插入/删除/重排义项都不会让进度错位。
 */

export type Tier = 'T1' | 'T2' | 'T3' | 'T4' | ''
export type Mastery = 'new' | 'learning' | 'mastered'

/** 词条 —— 一个单词 */
export interface Word {
  word: string // 主键
  ipa: string
  hidden: 0 | 1 // 暂时不学
  createdAt: number
  updatedAt: number
}

/** 义项 —— 一张卡片的单位。一个词有多个义项。 */
export interface Sense {
  /** 内部 UUID，永不变。学习进度与例句都挂这里。 */
  id: string
  word: string
  /** 显示编号 1/2/3…，可重排、可插空。UI 显示 s{slot}。 */
  slot: number
  pos: string
  gloss: string
  glossEn: string
  note: string
  /** 熟词僻义：词常见但这个意思少见，起始间隔最短（03 §3 TRAP） */
  trap: 0 | 1
  /** 词频档，来自原内容产线分层（已删除，git 历史可查）；T3/T4 视为低频（03 §3 RARE） */
  tier: Tier
  /** 骨架词标记：只给了一个义项，用到时再补 */
  needsRefine: 0 | 1
  /** 软删除时间戳，null = 存活 */
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 例句 */
export interface Sentence {
  id?: number
  senseId: string
  idx: number
  en: string
  zh: string
  /** 句中目标词所在的字符区间 —— 训练页据此高亮（sentence.clue 是给用户的提示语） */
  spanStart: number
  spanLen: number
  form: string
  clue: string
  /** 「这句有问题」，标记后不再出题 */
  flagged: 0 | 1
  /** 标记时写的备注（内容侧 triage 时要看） */
  flagNote: string
}

/** 学习进度 —— 按义项独立计算 */
export interface Progress {
  senseId: string // 主键，FK → Sense.id
  stability: number
  difficulty: number
  lastReview: number | null
  dueAt: number
  reps: number
  wrongN: number
  pendingN: number
  mastered: 0 | 1
  rusty: 0 | 1
  /**
   * 「排进某一次练习」的时间戳（秒）：到点之后这张卡**排在最前面**，
   * 不管它的 SRS 到期时间。
   *
   * ★ 为什么需要它：看到生词时的念头是「这个词我明天想练」。
   *   SRS 给不了这种「人为插队」—— 新词的 dueAt 是 0（随时可练，也就不突出），
   *   已掌握的词更是要等很久。pin 是唯一的「我说了算」的通道。
   * ★ 它不改 S/D/reps：排期是**意图**，不是学习记录 —— 答完照样走 SRS。
   */
  pinAt?: number
}

/** 一次作答流水（只增不改） */
export interface ReviewLog {
  sessionId: string
  idx: number
  senseId: string
  result: 'CORRECT' | 'WRONG' | 'PENDING'
  grade: number
  elapsedMs: number | null
  isDue: 0 | 1
  stabilityAfter: number | null
  ts: number
}

/** 导入历史（可追溯、可回滚） */
export interface ImportLog {
  id?: number
  ts: number
  word: string
  source: string
  summary: string
}

/** 导入前的自动快照 —— 只含内容层，回滚不动学习进度 */
export interface Snapshot {
  id?: number
  ts: number
  label: string
  /** Word/Sense/Sentence 的完整数组，JSON 字符串 */
  payload: string
}

/** 出题时 SRS 需要的卡片视图（把 Sense + Word + 计数拼起来） */
export interface CardView {
  id: string // sense.id
  word: string
  senseId: string
  slot: number
  pos: string
  gloss: string
  glossEn: string
  note: string
  isTrap: 0 | 1
  tier: Tier
  /** 该词一共几个义项 —— classify() 要用 */
  nSenses: number
}

/** SRS 输入：只喂它判断类型需要的那几个字段。
 *  字段名必须与 app/srs.mjs 的 classify() 完全一致（is_trap / sense_id），
 *  改名的后果是「全部义项都判成 NEW」，起始间隔全错 —— 且不会报错，只会悄悄变慢。 */
export interface SrsCard {
  is_trap: 0 | 1
  tier: Tier
  /** 形如 's1' / 's2'，classify() 用它判断「多义词的第一个义项」 */
  sense_id: string
  n_senses: number
}

/** SRS 状态：与 app/srs.mjs 的 st 同构，便于对照 */
export interface SrsState {
  stability: number
  difficulty: number
  reps: number
  wrong_n: number
  pending_n: number
  last_review: number | null
}


/** 进度 → 熟练度标签（UI 用；判定依据见 isMastered） */
export function masteryOf(p: Progress | undefined): Mastery {
  if (!p || p.reps === 0) return 'new'
  if (p.mastered) return 'mastered'
  return 'learning'
}

/** 熟练度 → 进度条百分比（0..100）。S0 起步约 0.6 天 ≈ 8%，S0_TRAP 0.8 ≈ 11%。 */
export function masteryPercent(p: Progress | undefined): number {
  if (!p || p.reps === 0) return 0
  const days = p.stability
  if (days >= 30) return 100
  return Math.max(4, Math.min(96, Math.round((days / 30) * 100)))
}
