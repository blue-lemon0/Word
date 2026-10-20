/** 神经 TTS —— 在线合成的英文朗读（explore/tts 探索分支原型）。
 *
 *  ★ 路线结论（本分支探索的产出）：
 *    - Edge TTS 网页直连：服务端校验 Origin，浏览器伪造不了 → 死路；
 *    - Edge TTS 原生 WebSocket（okhttp，免 key 免费）→ **主力**，原生协议见
 *      EdgeTts.java，页面侧的 edgeSynthesize 在本文件；
 *    - 在线神经 TTS（OpenAI 兼容 /audio/speech，硅基流动）→ 备用（需 key）；
 *    - 系统 TextToSpeech：兜底，现有 speak 链路一行没动。
 *
 *  ★ 为什么放在 ai/ 里：D38 守卫「AI 代码只在 ai/ 里」的本意是外网调用
 *    内聚、密钥不出本机 —— 神经 TTS 是同一条边界上的能力，天然归这里管。
 *
 *  ★ 配置存 localStorage（`wb.tts.config`），不进备份 —— 与 AI key 同一
 *    约定。桌面开发时在控制台贴一行即可：
 *      localStorage.setItem('wb.tts.config', JSON.stringify({apiKey:'sk-...'}))
 *    Edge 这条路不需要任何配置：有原生桥就能用。
 *
 *  缓存：合成一次的音频进 IndexedDB（wb-tts-cache），key 带 provider 前缀
 *  （edge|… / model|voice|speed|…）—— 同一句话第二遍起零延迟、零花费。
 */
import { nativeBridge } from '../bridge'

export interface TtsConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  speed: number
}

export const DEFAULT_TTS_CONFIG: TtsConfig = {
  enabled: true,
  baseUrl: 'https://api.siliconflow.cn/v1',
  apiKey: '',
  model: 'FunAudioLLM/CosyVoice2-0.5B',
  voice: 'FunAudioLLM/SpeechSynthesis:SpeechSeaSkye',
  speed: 1.0,
}

/** Edge 主力音色（edge-tts 7.3.1 的库默认，多语言，男声可用 Andrew）。 */
export const EDGE_VOICE = 'en-US-EmmaMultilingualNeural'
/** 对齐 speakEn 的语速 0.9：backoff 百分比写死，避免两处常量互相推导。 */
export const EDGE_RATE = '-10%'

const CFG_KEY = 'wb.tts.config'

export function loadTtsConfig(): TtsConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_TTS_CONFIG }
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (!raw) return { ...DEFAULT_TTS_CONFIG }
    const o = JSON.parse(raw) as Partial<TtsConfig>
    // 逐字段兜底：配置缺字段时不该把朗读搞崩
    return {
      enabled: o.enabled !== false,
      baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : DEFAULT_TTS_CONFIG.baseUrl,
      apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
      model: typeof o.model === 'string' && o.model ? o.model : DEFAULT_TTS_CONFIG.model,
      voice: typeof o.voice === 'string' && o.voice ? o.voice : DEFAULT_TTS_CONFIG.voice,
      speed: Number.isFinite(o.speed) ? Number(o.speed) : DEFAULT_TTS_CONFIG.speed,
    }
  } catch {
    return { ...DEFAULT_TTS_CONFIG }
  }
}

/** 没配 key 时硅基流动这条路根本不存在。 */
export function neuralPossible(c: TtsConfig = loadTtsConfig()): boolean {
  return c.enabled && !!c.apiKey.trim()
}

/** Edge 路的同步判据：有原生桥就能用，免 key 免配置。 */
export function edgePossible(): boolean {
  return typeof nativeBridge?.edgeTts === 'function'
}

/* ── 音频缓存（IndexedDB，尽力而为：坏了不影响朗读，只是慢一点、费一点）── */
const DB_NAME = 'wb-tts-cache'
const STORE = 'audio'

function cacheGet(key: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        const db = req.result
        try {
          const get = db.transaction(STORE).objectStore(STORE).get(key)
          get.onsuccess = () => resolve(get.result instanceof Blob ? get.result : null)
          get.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function cachePut(key: string, blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve()
      return
    }
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        const db = req.result
        try {
          const tx = db.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).put(blob, key)
          tx.oncomplete = () => resolve()
          tx.onerror = () => resolve()
          tx.onabort = () => resolve()
        } catch {
          resolve()
        }
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

/* ── 原生二进制通道：id → Promise 接线（模式同 transport.ts 的 waiters 表）──
 *
 *  httpPostBin（硅基流动）与 edgeTts（Edge 原生 WS）共用一张 waiters 表、
 *  一套结算逻辑 —— id 前缀区分来源。判定逻辑只写一份，两路不会走岔。
 *  回调必须在**发送之前**挂好 —— 先发后挂，快网下会漏掉结果（真坑）。
 */
type BinWaiter = {
  done: (r: { status: number; b64: string }) => void
  fail: (e: Error) => void
  timer: number
}
const binWaiters = new Map<string, BinWaiter>()
let binSeq = 0

declare global {
  interface Window {
    __wbHttpBin?: (id: string, status: number, b64: string) => void
    __wbEdgeTts?: (id: string, status: number, b64: string) => void
  }
}

function settleBin(id: string, status: number, b64: string): void {
  const w = binWaiters.get(id)
  if (!w) return
  binWaiters.delete(id)
  clearTimeout(w.timer)
  if (status < 0) {
    let msg = '原生网络请求失败'
    try {
      // 原生端回的是 UTF-8 字节的 Base64，atob 只出 Latin-1 —— 中文消息必须重解
      msg = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) || msg
    } catch {
      /* 保底消息 */
    }
    w.fail(new Error(msg))
  } else {
    w.done({ status, b64 })
  }
}

function installBinCallback(): void {
  if (typeof window === 'undefined' || window.__wbHttpBin) return
  window.__wbHttpBin = settleBin
  window.__wbEdgeTts = settleBin
}

function postBinNative(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; b64: string }> {
  return new Promise((resolve, reject) => {
    if (typeof nativeBridge?.httpPostBin !== 'function') {
      reject(new Error('没有原生二进制网络能力'))
      return
    }
    installBinCallback()
    const id = `tts${++binSeq}`
    const timer = window.setTimeout(() => {
      binWaiters.delete(id)
      reject(new Error('超时'))
    }, timeoutMs)
    binWaiters.set(id, { done: resolve, fail: (e) => reject(e), timer })
    try {
      nativeBridge.httpPostBin(id, url, JSON.stringify(headers), body)
    } catch (e) {
      binWaiters.delete(id)
      clearTimeout(timer)
      reject(new Error(String(e)))
    }
  })
}

/* ── 播放 ──
 *  声音不叠加：开播前把系统 TTS（原生引擎 / Web Speech）都按停，
 *  自己这条链上的上一段也按停。
 */
let current: HTMLAudioElement | null = null
let currentUrl = ''

export function stopNeural(): void {
  if (current) {
    current.pause()
    current.removeAttribute('src')
    current = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = ''
  }
}

async function playBlob(blob: Blob): Promise<boolean> {
  stopNeural()
  try {
    nativeBridge?.stopSpeak?.()
    window.speechSynthesis?.cancel()
  } catch {
    /* 各环境缺什么就缺什么 */
  }
  const url = URL.createObjectURL(blob)
  try {
    const a = new Audio(url)
    current = a
    currentUrl = url
    a.onended = () => {
      if (current === a) stopNeural()
    }
    await a.play()
    return true
  } catch {
    stopNeural()
    return false
  }
}

/* ── 合成 ── */

/** 桌面开发没有原生桥，fetch 直连第三方 API 会被 CORS 拦 —— vite 的
 *  /tts 代理同源转发（与 AI 的 /ai 同一招）。APK 里走原生，用不到它。 */
function devProxyUrl(url: string): string {
  if (typeof window === 'undefined') return url
  const h = window.location.hostname
  if (h === 'localhost' || h === '127.0.0.1') return url.replace(/^https?:\/\/[^/]+/, '/tts')
  return url
}

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function synthesize(cfg: TtsConfig, t: string): Promise<Blob> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey.trim()}`,
  }
  const body = JSON.stringify({
    model: cfg.model,
    input: t,
    voice: cfg.voice,
    response_format: 'mp3',
    speed: cfg.speed,
  })
  const url = devProxyUrl(cfg.baseUrl.replace(/\/+$/, '') + '/audio/speech')
  if (typeof nativeBridge?.httpPostBin === 'function') {
    const res = await postBinNative(url, headers, body, 30000)
    if (res.status !== 200) {
      let msg = `HTTP ${res.status}`
      try {
        const o = JSON.parse(atob(res.b64)) as { message?: string }
        if (o && typeof o.message === 'string') msg = `${msg}: ${o.message}`
      } catch {
        /* 就用状态码 */
      }
      throw new Error(msg)
    }
    return b64ToBlob(res.b64, 'audio/mpeg')
  }
  // 浏览器（桌面 dev 走 vite 代理能通；生产 Web 没有 CORS 允许会快速失败 → 回退）
  const r = await fetch(url, { method: 'POST', headers, body })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.blob()
}

/** Edge 原生合成：调桥 → 原生 WS 收 mp3 → Base64 回调 → Blob。
 *  音色/语速用模块常量（EDGE_VOICE / EDGE_RATE），不进配置 —— 免 key 的
 *  路就该零配置。 */
function edgeSynthesize(t: string): Promise<Blob> {
  return new Promise<{ status: number; b64: string }>((resolve, reject) => {
    if (typeof nativeBridge?.edgeTts !== 'function') {
      reject(new Error('没有原生 Edge 桥'))
      return
    }
    installBinCallback()
    const id = `etts${++binSeq}`
    const timer = window.setTimeout(() => {
      binWaiters.delete(id)
      reject(new Error('超时'))
    }, 20000)
    binWaiters.set(id, { done: resolve, fail: (e) => reject(e), timer })
    try {
      nativeBridge.edgeTts(id, t, EDGE_VOICE, EDGE_RATE)
    } catch (e) {
      binWaiters.delete(id)
      clearTimeout(timer)
      reject(new Error(String(e)))
    }
  }).then((r) => {
    if (r.status !== 200) throw new Error(`Edge TTS 失败`)
    const b = b64ToBlob(r.b64, 'audio/mpeg')
    if (b.size < 500) throw new Error('响应太小，多半不是音频')
    return b
  })
}

const sleep = (ms: number): Promise<null> => new Promise((r) => setTimeout(r, ms))

/* ── 熔断：连续失败 3 次才退回系统 TTS ──
 *  用户拍板「能等就等」：单次合成不设竞速窗口，慢慢等。
 *  但断网/服务挂掉时不能每句都傻等超时 —— 连续失败 3 次就认定在线路
 *  已死，之后直接让位系统 TTS；一次成功立刻复位计数。
 */
const MAX_FAILURES = 3
let consecutiveFailures = 0

/** 在线路当前是否还值得试（熔断未开 + 至少一条路存在）。speech.ts 用它做同步快路径。 */
export function onlineAlive(): boolean {
  return consecutiveFailures < MAX_FAILURES && (edgePossible() || neuralPossible())
}

/** 单次合成的硬超时：断网时原生端 30s 才放弃，页面侧 20s 先撒手。 */
const HARD_TIMEOUT_MS = 20000

/**
 * 合成并播放一句话。返回 false = 让位给系统 TTS（调用方负责兜底）。
 *
 *  ★ 等待策略（用户拍板）：缓存命中立刻播；未命中就**等到出结果**，
 *    Edge（免 key）与硅基流动（配了 key）并行，谁先到货播谁；
 *    全部失败或硬超时才让位，且计入熔断计数（连续 3 次后不再尝试）。
 */
export async function speakOnline(text: string): Promise<boolean> {
  const cfg = loadTtsConfig()
  const t = text.trim()
  const useEdge = edgePossible()
  const useNeural = neuralPossible(cfg)
  if (!t || !useEdge && !useNeural) return false

  // 缓存先行：谁有缓存播谁（第二遍起零延迟零花费）
  const edgeKey = `edge|${EDGE_VOICE}|${EDGE_RATE}|${t}`
  const neuralKey = `${cfg.model}|${cfg.voice}|${cfg.speed}|${t}`
  if (useEdge) {
    const hit = await cacheGet(edgeKey)
    if (hit) {
      consecutiveFailures = 0
      return playBlob(hit)
    }
  }
  if (useNeural) {
    const hit = await cacheGet(neuralKey)
    if (hit) {
      consecutiveFailures = 0
      return playBlob(hit)
    }
  }

  // 并行竞速。失败的 job 变成永久 pending 不参与 race —— race 只认「先到货的音频」。
  const jobs: Promise<Blob | null>[] = []
  if (useEdge) {
    jobs.push(
      edgeSynthesize(t)
        .then((b) => {
          void cachePut(edgeKey, b)
          return b
        })
        .catch(() => null),
    )
  }
  if (useNeural) {
    jobs.push(
      synthesize(cfg, t)
        .then((b) => {
          if (b.size < 500) throw new Error('响应太小，多半不是音频')
          void cachePut(neuralKey, b)
          return b
        })
        .catch(() => null),
    )
  }
  const never = new Promise<never>(() => undefined)
  // 全部失败也要能收场：所有 job 结算后若无货，Promise.all 出 null 触发熔断计数
  const allSettled = Promise.all(jobs).then(() => null)
  const winner = await Promise.race([
    ...jobs.map((j) => j.then((b) => (b ? { b } : never))),
    allSettled,
    sleep(HARD_TIMEOUT_MS),
  ])
  if (winner && winner.b) {
    consecutiveFailures = 0
    return playBlob(winner.b)
  }
  consecutiveFailures++
  return false
}
