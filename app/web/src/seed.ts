/** 启动引导 —— 首次打开时灌入种子词库
 *
 *  种子是内容产线的真实产物 build/bundle/cards_v2.json（产线已删除，git 历史可查），
 *  走的是和 AI 导入**同一条** importBundle() 路径 —— 所以一旦这条路径通了，
 *  AI 补词就一定通。这不是巧合，是刻意的：管道产出和 AI 产出是同一种东西。
 */
import { db } from './db'
import { importBundle } from './import'

let booting: Promise<void> | null = null

export function ensureSeeded(): Promise<void> {
  if (booting) return booting
  booting = (async () => {
    const n = await db.words.count()
    if (n > 0) return
    try {
      const res = await fetch(new URL('seed.json', document.baseURI))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const rep = await importBundle(json)
      console.info(
        `[seed] 词+${rep.wordsAdded} 义+${rep.sensesAdded} 句+${rep.sentencesAdded}` +
          (rep.errors.length ? ` 错误${rep.errors.length}: ${rep.errors[0]}` : ''),
      )
    } catch (e) {
      console.error('[seed] 失败', e)
    }
  })()
  return booting
}

