/** 启动引导 —— 首次打开时让用户选择怎么开始。
 *
 *  ★ 为什么不再自动灌种子：种子只是「用来体验流程的示例」，
 *    不是用户的词库。一上来塞 18 个词，里面大半是用户不需要的义项，
 *    还夹着没例句、甚至释义不准的卡 —— 比空库更劝退。
 *
 *  ★ 三条路都留了出口：
 *    · 用示例开始 —— 3 个词 / 7 个义项 / 14 句，够走完一遍完整流程；
 *      之后可在「更多 → 示例词库」清掉没学过的部分。
 *    · 导入自己的词库 —— 内容包或备份都行，走和「更多」同一个分派。
 *    · 先空着 —— 首页空态里仍有「用示例开始 / 导入 / 自己去加词」。
 *
 *  种子走的是和 AI 导入**同一条** importBundle() 路径，所以管道产出和
 *  AI 产出永远是同一种东西。
 */
import { ref } from 'vue'
import { snapshot } from './backup'
import { db, purgeWords } from './db'
import { importBundle } from './import'

const CHOICE_KEY = 'wb.seedChoice'
const WORDS_KEY = 'wb.sampleWords'

type SeedChoice = 'sample' | 'skip'

/** 首启欢迎层是否要显示（main.ts 在挂载前定好，App.vue 直接读） */
export const seedWelcomeOpen = ref(false)

function readChoice(): SeedChoice | null {
  try {
    const v = localStorage.getItem(CHOICE_KEY)
    return v === 'sample' || v === 'skip' ? v : null
  } catch {
    return null
  }
}

function writeChoice(c: SeedChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, c)
  } catch {
    /* 隐私模式下 localStorage 可能不可写，不影响本次使用 */
  }
}

/** 记下这次灌进去的示例词名，清空时只动这些 */
function writeSampleWords(words: string[]): void {
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify(words))
  } catch {
    /* 同上 */
  }
}

export function sampleWordNames(): string[] {
  try {
    const raw = localStorage.getItem(WORDS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((w): w is string => typeof w === 'string' && !!w) : []
  } catch {
    return []
  }
}

/** 下载并导入示例词库。失败会抛，由调用方决定怎么提示。 */
export async function importSampleSeed(): Promise<{
  words: number
  senses: number
  sentences: number
}> {
  const res = await fetch(new URL('seed.json', document.baseURI), { cache: 'no-cache' })
  if (!res.ok) throw new Error(`示例词库下载失败（HTTP ${res.status}）`)
  const json = (await res.json()) as { cards?: Array<{ word?: string }> }
  const rep = await importBundle(json)
  if (rep.errors.length) console.warn('[seed] 导入时有跳过的条目', rep.errors)
  const names = [
    ...new Set((json.cards ?? []).map((c) => (c.word ?? '').trim()).filter(Boolean)),
  ]
  writeSampleWords(names)
  writeChoice('sample')
  console.info(
    `[seed] 示例词 词+${rep.wordsAdded} 义+${rep.sensesAdded} 句+${rep.sentencesAdded}`,
  )
  return { words: rep.wordsAdded, senses: rep.sensesAdded, sentences: rep.sentencesAdded }
}

export function skipSampleSeed(): void {
  writeChoice('skip')
  seedWelcomeOpen.value = false
}

/** 启动时问一次：只有「空库 + 还没做过选择」才弹欢迎层。
 *
 *  已经选过「示例」但库又空了（例如导入失败后重装），自动补一次；
 *  选过「先空着」就不再打扰。 */
export async function shouldAskSeed(): Promise<boolean> {
  if ((await db.words.count()) > 0) {
    seedWelcomeOpen.value = false
    return false
  }
  const choice = readChoice()
  if (choice === 'skip') {
    seedWelcomeOpen.value = false
    return false
  }
  if (choice === 'sample') {
    try {
      await importSampleSeed()
    } catch (e) {
      console.error('[seed] 补灌示例词失败', e)
    }
    seedWelcomeOpen.value = (await db.words.count()) === 0
    return seedWelcomeOpen.value
  }
  // 没做过选择、但已经有导入/快照记录：这是「用过之后自己清空了」，
  // 不是第一次打开 —— 不再拦一层欢迎页，首页空态已经给了同样的三个入口。
  if ((await db.importLog.count()) > 0 || (await db.snapshots.count()) > 0) {
    seedWelcomeOpen.value = false
    return false
  }
  seedWelcomeOpen.value = true
  return true
}

export interface SampleInfo {
  /** 库里还存在的示例词数 */
  present: number
  /** 其中已经开始学的词数（有作答/纳入进度） */
  learned: number
  /** 可以安全清掉的词名（没有任何学习记录） */
  removable: string[]
}

export async function sampleInfo(): Promise<SampleInfo> {
  const names = sampleWordNames()
  if (!names.length) return { present: 0, learned: 0, removable: [] }

  const [senses, words] = await Promise.all([
    db.senses.where('word').anyOf(names).toArray(),
    db.words.where('word').anyOf(names).toArray(),
  ])
  if (!senses.length && !words.length) return { present: 0, learned: 0, removable: [] }

  const progress = await db.progress.bulkGet(senses.map((s) => s.id))
  const present = new Set<string>(words.map((w) => w.word))
  const learned = new Set<string>()
  senses.forEach((s, i) => {
    present.add(s.word)
    const p = progress[i]
    if (p && (p.reps > 0 || p.mastered || p.wrongN > 0 || p.pendingN > 0)) learned.add(s.word)
  })

  const removable = [...present].filter((w) => !learned.has(w))
  return { present: present.size, learned: learned.size, removable }
}

/** 清掉没学过的示例词；清之前自动快照，误删可回滚。
 *  已经学过的示例词原样保留 —— 学习记录不能被一次「清理」抹掉。 */
export async function clearSampleWords(): Promise<{ words: number; senses: number }> {
  const info = await sampleInfo()
  if (!info.removable.length) return { words: 0, senses: 0 }
  await snapshot(`清空示例词库前（${info.removable.length} 个词）`)
  const r = await purgeWords(info.removable)
  if (r.words > 0 && info.present - r.words <= 0) {
    writeChoice('skip')
    try {
      localStorage.removeItem(WORDS_KEY)
    } catch {
      /* 忽略 */
    }
  } else if (r.words > 0) {
    writeSampleWords(sampleWordNames().filter((w) => !info.removable.includes(w)))
  }
  return r
}
