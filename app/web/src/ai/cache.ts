/** AI 结果缓存 —— 「能省则省」里最直接的一条。
 *
 *  ★ 缓存的是**结果**，不是「问过一次」这件事：
 *    键里含内容指纹（词条/义项/例句的当前值）与模型名。内容一改，键就变，
 *    于是不会拿着旧建议去改新内容 —— 那比没有缓存更危险。
 *
 *  ★ 也不设过期时间：内容没变就永远有效；模型换了键里就有新模型名。
 *    唯一的成本是 IndexedDB 里多几 KB 文本，上限靠「每个词最多几条」兜住。
 */
import { db } from '../db'

/** 稳定的字符串指纹（FNV-1a 32 位 + 长度）。冲突概率对「同一台设备上几百个词」足够。 */
export function hashOf(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16)}-${input.length.toString(16)}`
}

export interface AiCacheRow {
  id: string
  ts: number
  model: string
  payload: string
}

export async function cacheGet(id: string): Promise<AiCacheRow | undefined> {
  try {
    return await db.aiCache.get(id)
  } catch {
    return undefined // 缓存坏了不该让功能挂掉
  }
}

export async function cachePut(id: string, model: string, payload: string): Promise<void> {
  try {
    await db.aiCache.put({ id, ts: Date.now(), model, payload })
  } catch {
    /* 写不进去就算了，下次重新问 */
  }
}

export async function cacheClear(): Promise<number> {
  const n = await db.aiCache.count()
  await db.aiCache.clear()
  return n
}

export async function cacheInfo(): Promise<{ count: number; chars: number }> {
  const rows = await db.aiCache.toArray()
  return { count: rows.length, chars: rows.reduce((n, r) => n + r.payload.length, 0) }
}
