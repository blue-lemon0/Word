/** 神经 TTS —— 在线合成的英文朗读（explore/tts 探索分支原型）。
 *
 *  ★ 路线结论（本分支探索的产出）：
 *    - Edge TTS 网页直连：服务端校验 Origin，浏览器伪造不了 → 死路；
 *    - 在线神经 TTS（OpenAI 兼容 /audio/speech）+ 原生桥发请求 → 本文件；
 *    - 系统 TextToSpeech：兜底，现有 speak 链路一行没动。
 *
 *  ★ 为什么放在 ai/ 里：D38 守卫「AI 代码只在 ai/ 里」的本意是外网调用
 *    内聚、密钥不出本机 —— 神经 TTS 是同一条边界上的能力（同一家
 *    OpenAI 兼容供应商体系、同一个 Bearer 认证），天然归这里管。
 *
 *  ★ 配置存 localStorage（`wb.tts.config`），不进备份 —— 与 AI key 同一
 *    约定。桌面开发时在控制台贴一行即可：
 *      localStorage.setItem('wb.tts.config', JSON.stringify({apiKey:'sk-...'}))
 *
 *  缓存：合成一次的音频进 IndexedDB（wb-tts-cache），key 是
 *  model|voice|speed|text —— 同一句话第二遍起零延迟、零花费。
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

/** 没配 key 时神经这条路根本不存在 —— speech.ts 用它做**同步**快路径，
 *  保证「没配」的用户行为与改动前一致（不引入任何异步）。 */
export function neuralPossible(c: TtsConfig = loadTtsConfig()): boolean {
  return c.enabled && !!c.apiKey.trim()
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
  }
}

function installBinCallback(): void {
  if (typeof window === 'undefined' || window.__wbHttpBin) return
  window.__wbHttpBin = (id: string, status: number, b64: string): void => {
    const w = binWaiters.get(id)
    if (!w) return
    binWaiters.delete(id)
    clearTimeout(w.timer)
    if (status < 0) {
      let msg = '原生网络请求失败'
      try {
        msg = atob(b64) || msg
      } catch {
        /* 保底消息 */
      }
      w.fail(new Error(msg))
    } else {
      w.done({ status, b64 })
    }
  }
}

function postBinNative(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; b64: string }> {
  const bridge = nativeBridge as unknown as {
    httpPostBin?: (id: string, url: string, headersJson: string, body: string) => void
  } | undefined
  return new Promise((resolve, reject) => {
    if (typeof bridge?.httpPostBin !== 'function') {
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
      bridge.httpPostBin(id, url, JSON.stringify(headers), body)
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
  const bridge = nativeBridge as unknown as { httpPostBin?: unknown } | undefined
  if (typeof bridge?.httpPostBin === 'function') {
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

const sleep = (ms: number): Promise<null> => new Promise((r) => setTimeout(r, ms))

/**
 * 合成并播放一句话。返回 false = 让位给系统 TTS（调用方负责兜底）。
 *
 *  ★ 等待窗口（maxWaitMs）：缓存命中立刻播；未命中时合成要 1~3 秒，
 *    干等就是「点了没声」。所以先竞速 —— 合成赶在窗口内就播神经音色；
 *    赶不上就让系统 TTS 先开口，音频到了只进缓存（下一遍起就是它了），
 *    绝不跟系统 TTS 抢耳朵。
 */
export async function speakNeural(text: string, maxWaitMs = 1200): Promise<boolean> {
  const cfg = loadTtsConfig()
  const t = text.trim()
  if (!neuralPossible(cfg) || !t) return false

  const key = `${cfg.model}|${cfg.voice}|${cfg.speed}|${t}`
  const hit = await cacheGet(key)
  if (hit) return playBlob(hit)

  const job = synthesize(cfg, t)
    .then((b) => {
      if (b.size < 500) throw new Error('响应太小，多半不是音频')
      void cachePut(key, b)
      return b
    })
    .catch(() => null)
  const winner = await Promise.race([job.then((b) => ({ b })), sleep(maxWaitMs).then(() => null)])
  if (winner && winner.b) return playBlob(winner.b)
  // 竞速输了：后台继续把音频收进缓存，但不播（系统 TTS 已经在说话了）
  return false
}
