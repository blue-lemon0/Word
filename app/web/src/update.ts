/** 检查更新 —— 只查 GitHub Release，不下载、不安装。
 *
 *  ★ 为什么只查最新正式版：/releases/latest 会自动排除 draft 和 prerelease，
 *    发版流水线又保证 tag 是 v<version>，所以这里不需要自己遍历 Release 列表。
 *  ★ 失败必须安静：GitHub 在部分网络下连不上，检查更新不能影响背单词。
 */

import { nativeBridge } from './bridge'

export const RELEASE_PAGE = 'https://github.com/blue-lemon0/Word/releases/latest'
export const RELEASE_API = 'https://api.github.com/repos/blue-lemon0/Word/releases/latest'
const APK_ASSET = 'app-release.apk'
const TIMEOUT_MS = 8000

export interface ReleaseInfo {
  tag: string
  version: string
  notes: string
  pageUrl: string
  apkUrl: string
  apkSize: number
  publishedAt: string
}

export type UpdateCheck =
  | { kind: 'available'; current: string; release: ReleaseInfo }
  | { kind: 'latest'; current: string; release: ReleaseInfo }
  | { kind: 'error'; message: string }

/** 把 v0.3.0 / 0.3.0-beta.1 / 0.3.0-debug 都归到 0.3.0 再比 */
export function normalizeVersion(v: string): string {
  const m = /^v?(\d+(?:\.\d+)*)/i.exec(v.trim())
  return m ? m[1] : ''
}

function partsOf(v: string): number[] {
  const n = normalizeVersion(v)
  return n ? n.split('.').map((x) => Number.parseInt(x, 10) || 0) : []
}

/** a < b 返回负数，相等返回 0，a > b 返回正数 */
export function compareVersions(a: string, b: string): number {
  const pa = partsOf(a)
  const pb = partsOf(b)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** GitHub Release JSON → 界面需要的字段；不是正式版或字段不全就返回 null */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null

  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : ''
  const version = normalizeVersion(tag)
  if (!tag || !version) return null

  const assets = Array.isArray(r.assets) ? r.assets : []
  const apk = assets.find(
    (a): a is Record<string, unknown> =>
      !!a &&
      typeof a === 'object' &&
      (a as Record<string, unknown>).name === APK_ASSET,
  )

  return {
    tag,
    version,
    notes: typeof r.body === 'string' ? r.body.trim() : '',
    pageUrl:
      typeof r.html_url === 'string' && r.html_url
        ? r.html_url
        : `https://github.com/blue-lemon0/Word/releases/tag/${encodeURIComponent(tag)}`,
    apkUrl: typeof apk?.browser_download_url === 'string' ? apk.browser_download_url : '',
    apkSize: typeof apk?.size === 'number' ? apk.size : 0,
    publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
  }
}

export function availability(release: ReleaseInfo, current: string): 'available' | 'latest' {
  return compareVersions(current, release.version) < 0 ? 'available' : 'latest'
}

/** Release 说明是 Markdown；App 里只当纯文本看，去掉最常见的标记，别把 ## / ** 直接摆给用户 */
export function plainNotes(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]*[-*][ \t]+/gm, '· ')
    .trim()
}

/** 手动检查一次；任何失败都变成可显示的一句话，不抛异常 */
export async function checkForUpdate(current: string): Promise<UpdateCheck> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(RELEASE_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    })
    if (res.status === 404) return { kind: 'error', message: 'GitHub 上还没有发布版本' }
    if (res.status === 403 || res.status === 429) {
      return { kind: 'error', message: 'GitHub 限流了，稍后再试' }
    }
    if (!res.ok) return { kind: 'error', message: `GitHub 返回 ${res.status}` }

    let json: unknown
    try {
      json = await res.json()
    } catch {
      return { kind: 'error', message: 'GitHub 返回的数据看不懂' }
    }
    const release = parseRelease(json)
    if (!release) return { kind: 'error', message: 'Release 数据不完整' }
    return { kind: availability(release, current), current, release }
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError'
    return { kind: 'error', message: aborted ? '连接 GitHub 超时' : '连不上 GitHub' }
  } finally {
    clearTimeout(timer)
  }
}

/** 当前装的是不是开发版（debug APK）。浏览器/PWA 没有原生桥，按非开发版处理。 */
export function isDebugApk(): boolean {
  try {
    const raw = nativeBridge?.appInfo?.()
    if (!raw) return false
    return (JSON.parse(raw) as { debug?: boolean }).debug === true
  } catch {
    return false
  }
}

/** 优先让原生壳用系统浏览器打开；没有桥时退回 window.open */
export function openExternal(url: string): void {
  try {
    if (nativeBridge?.openUrl?.(url)) return
  } catch {
    /* 桥坏了就继续走浏览器 */
  }
  window.open(url, '_blank', 'noopener')
}
