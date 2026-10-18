/** 点词查义 —— 把「句子里随便一个词」解析成词库里的词条与义项。
 *
 *  ★ 为什么要有这一层，而不是直接 `db.words.get(token)`：
 *    句子里出现的是**屈折形式**（ordered / sides / being / stopped），
 *    词库里存的是**原形**（order / side / be / stop）。直接查会大面积落空，
 *    而落空的表现在界面上是「这个词不在词库里」—— 用户会以为词库缺词，
 *    其实是这一步没做形态还原。
 *
 *  ★ 为什么规则这么土（剥后缀 + 去双写），不上词形库：
 *    这个词库是**自己产的**（2998 词），词形变化全在前台能看得见的范围内；
 *    第一条策略是「先按原形查」，只有落空了才走规则，而规则算出来的候选
 *    **必须真的在词库里**才会被采用（见 pick）—— 所以规则猜错也不会
 *    把人带到别的词上去，最多是「没找到」。这比引进一份词形词典便宜得多，
 *    而且没有额外真相源要对齐。
 *
 *  ★ 停用词不提供「加入词库」：the / of / was 这些加进去只是垃圾。
 *    它们仍然能被点到（否则句子千疮百孔），但浮层里只说「大概不用记」。
 */
import { allSentences, allWords, liveSenses } from './db'
import type { Sense, Word } from './types'

/** 句子里那些「不用记」的虚词：点到它们就说明一下，不提供加入入口。 */
const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its',
  'he', 'she', 'they', 'them', 'his', 'her', 'their', 'we', 'us', 'our', 'you',
  'your', 'i', 'me', 'my', 'is', 'am', 'are', 'was', 'were', 'be', 'been',
  'being', 'do', 'does', 'did', 'done', 'has', 'have', 'had', 'will', 'would',
  'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'not', 'no', 'so',
  'than', 'then', 'there', 'here', 'when', 'where', 'while', 'who', 'what',
  'which', 'how', 'why', 'all', 'any', 'some', 'one', 'two', 'very', 'just',
  'also', 'into', 'over', 'under', 'about', 'after', 'before', 'again', 'out',
  'up', 'down', 'off', 'only', 'more', 'most', 'such', 'own', 'same', 'other',
])

/** 把用户点的那个串弄成可查的形状：去标点、小写、保留词内连字符/撇号。 */
export function normalizeToken(raw: string): string {
  return raw
    .replace(/[^A-Za-z'’-]/g, '')
    .replace(/[’]/g, "'")
    .toLowerCase()
    .replace(/^[-']+|[-']+$/g, '')
}

/** 双写辅音去一个：stopp → stop、running → runn → run */
function undouble(s: string): string | null {
  if (s.length < 3) return null
  const a = s[s.length - 1]
  const b = s[s.length - 2]
  if (a === b && /[bdfglmnprt]/.test(a)) return s.slice(0, -1)
  return null
}

/**
 * 形态候选，**按可信度排序**，第一条永远是原样。
 *
 *  这一层是纯函数（不读库），所以能单独测：候选的顺序错了，
 *  查词的命中就会从「defend」掉到「defen」这种不存在的词上。
 */
export function guessLemmas(raw: string): string[] {
  const w = normalizeToken(raw)
  if (!w) return []
  const out: string[] = []
  const push = (s: string | null | undefined): void => {
    if (!s || s.length < 2) return
    if (!out.includes(s)) out.push(s)
  }
  push(w)

  // 所有格 / 缩写：worker's → worker，don't → don't（保留，词库里不会有）
  if (w.endsWith("'s")) push(w.slice(0, -2))

  const add = (stem: string): void => {
    push(stem)
    push(stem + 'e') // used → use、liking → like
    push(undouble(stem))
  }

  if (w.endsWith('ies') || w.endsWith('ied')) {
    push(w.slice(0, -3) + 'y') // studies → study、tried → try
  }
  if (w.endsWith('es')) {
    // 两个候选都可能对，先排可能性大的那个：
    //   · 去掉 es 之后以 s/x/z/ch/sh 结尾 → 是复数/三单的 -es：boxes → box
    //   · 否则只去掉一个 s → sides → side、makes → make
    // 顺序反了的话 sides 会先得到 sid、boxes 会先得到 boxe（都不像词）。
    const dropEs = w.slice(0, -2)
    const dropS = w.slice(0, -1)
    if (/(s|x|z|ch|sh)$/.test(dropEs)) {
      push(dropEs)
      push(dropS)
    } else {
      push(dropS)
      push(dropEs)
    }
  } else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) {
    push(w.slice(0, -1)) // sides → side
  }
  if (w.endsWith('ing')) {
    add(w.slice(0, -3)) // working → work / make(ing) / running → run
  } else if (w.endsWith('ed')) {
    add(w.slice(0, -2)) // ordered → order / use(d) / stopped → stop
  } else if (w.endsWith('est')) {
    add(w.slice(0, -3)) // biggest → big
  } else if (w.endsWith('er')) {
    add(w.slice(0, -2)) // bigger → big、worker → work
  } else if (w.endsWith('ly')) {
    push(w.slice(0, -2)) // quickly → quick
  }
  return out
}

export interface PeekResult {
  /** 用户点的那一格（规范化之后） */
  token: string
  /** 命中的词库词条；没命中时是「最像原形」的那个候选 */
  lemma: string
  /** 原形直接命中（false 说明走了形态还原） */
  exact: boolean
  /** 虚词：点到它不该提供「加入词库」 */
  stop: boolean
  /** 词库里的词条行（没入库时 undefined） */
  word?: Word
  senses: Sense[]
  /** 每个义项有几条例句 —— 浮层里要让人知道「点进去有没有东西看」 */
  sentenceCounts: Map<string, number>
}

/**
 * 查一个词：先按原形，再按形态候选（候选必须在词库里才算数）。
 *
 *  这一步只读内存缓存（`allWords` / `liveSenses`），因为点词要**立刻**出结果：
 *  转成一个加载态再等一次 IndexedDB，手感上就是一卡。
 */
export async function peekWord(raw: string): Promise<PeekResult> {
  const token = normalizeToken(raw)
  const candidates = guessLemmas(raw)
  const words = await allWords()
  const byWord = new Map(words.map((w) => [w.word, w]))

  let hit: string | undefined
  for (const c of candidates) {
    if (byWord.has(c)) {
      hit = c
      break
    }
  }
  // 单个词可能有另一条路命中：词库里存的就是这个形式（forms/派生词）
  //
  // ★ 没命中时，候选原形取「第一个派生候选」而不是句子里的形式本身：
  //   句子里的 ordered / sides / blorping 都是**变形**，直接拿它当词条加进词库，
  //   词库里就会多出 ordered 这种永远查不全的词。派生候选为空（本来就是原形）
  //   时才退回 token 本身。
  const guess = hit ?? candidates[1] ?? candidates[0] ?? token
  const lemma = guess
  const word = hit ? byWord.get(hit) : undefined
  const senses = word
    ? (await liveSenses()).filter((s) => s.word === word.word).sort((a, b) => a.slot - b.slot)
    : []

  const sentenceCounts = new Map<string, number>()
  if (senses.length) {
    const sents = await allSentences()
    for (const s of senses) sentenceCounts.set(s.id, 0)
    for (const sen of sents) {
      const n = sentenceCounts.get(sen.senseId)
      if (n != null) sentenceCounts.set(sen.senseId, n + 1)
    }
  }

  return {
    token,
    lemma,
    exact: !!hit && hit === token,
    stop: STOP.has(token) || STOP.has(lemma),
    word,
    senses,
    sentenceCounts,
  }
}

/** 这个词在词库里吗（给浮层之外的地方用，比如例句里标一下哪些词是「库里的」）。 */
export async function inLibrary(raw: string): Promise<boolean> {
  const words = await allWords()
  const set = new Set(words.map((w) => w.word))
  return guessLemmas(raw).some((c) => set.has(c))
}
