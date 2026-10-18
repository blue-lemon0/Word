/** 传输层 —— 「怎么把一段 JSON 发出去、把回复拿回来」。
 *
 *  ★ 为什么单独一层：WebView 里 `fetch` 打到第三方 API 会被 **CORS** 拦掉
 *    （对方不给你 ACAO 头，浏览器就连请求都不发）。桌面浏览器同理。
 *    所以真正能用的路有三条，而上面一层不该知道走了哪条：
 *
 *      1. 原生桥（APK 里）：Java 用 HttpURLConnection 发，**没有 CORS** 这回事；
 *      2. 开发代理（`npm run dev`）：vite 的 `/ai` 代理同源转发；
 *      3. 直接 fetch：某些自建网关允许跨域时可用。
 *
 *    判定顺序就是上面这个顺序 —— 能力最强的先试。
 */
import { nativeBridge } from '../bridge'
import { AiError } from './types'

export interface HttpResult {
  status: number
  body: string
}

export interface Transport {
  readonly name: 'native' | 'fetch'
  postJson(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<HttpResult>
}

/* ── 1. 原生桥 ──
 *
 *  @JavascriptInterface 只能同步返回基本类型，所以「发出去 → 等回复」必须
 *  分成两半：Java 那边起线程、拿到结果后 evaluateJavascript 回调
 *  `window.__wbHttp(id, status, text)`；这边用一张 id → resolve 的表接住。
 *
 *  几个必须做对的地方（每个都是真实的坑）：
 *   · 回调函数必须在**发送之前**挂好：先发后挂，快网下会漏掉结果；
 *   · 超时要自己兜：原生线程卡住时页面这边不能永远 pending；
 *   · 真机上页面重启（重进 app）会丢掉 pending，所以表要能整体清掉。
 */
type Waiter = { done: (r: HttpResult) => void; fail: (e: Error) => void; timer: number }
const waiters = new Map<string, Waiter>()
let seq = 0

declare global {
  interface Window {
    __wbHttp?: (id: string, status: number, text: string) => void
  }
}

function installCallback(): void {
  if (typeof window === 'undefined' || window.__wbHttp) return
  window.__wbHttp = (id: string, status: number, text: string): void => {
    const w = waiters.get(id)
    if (!w) return
    waiters.delete(id)
    clearTimeout(w.timer)
    if (status < 0) w.fail(new Error(text || '原生网络请求失败'))
    else w.done({ status, body: text })
  }
}

const nativeTransport: Transport = {
  name: 'native',
  postJson(url, headers, body, timeoutMs) {
    installCallback()
    const bridge = nativeBridge as unknown as {
      httpPost?: (id: string, url: string, headersJson: string, body: string) => void
    } | undefined
    return new Promise<HttpResult>((resolve, reject) => {
      if (!bridge?.httpPost) {
        reject(new Error('没有原生网络能力'))
        return
      }
      const id = `h${++seq}`
      const timer = window.setTimeout(() => {
        waiters.delete(id)
        reject(new AiError('network', '超时（原生请求没在时限内回来）'))
      }, timeoutMs)
      waiters.set(id, {
        done: resolve,
        fail: (e) => reject(new AiError('network', e.message)),
        timer,
      })
      try {
        bridge.httpPost(id, url, JSON.stringify(headers), body)
      } catch (e) {
        waiters.delete(id)
        clearTimeout(timer)
        reject(new AiError('network', String(e)))
      }
    })
  },
}

/* ── 2/3. fetch（开发代理与允许跨域的网关都走它）─── */
const fetchTransport: Transport = {
  name: 'fetch',
  async postJson(url, headers, body, timeoutMs) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: ctl.signal,
      })
      const text = await res.text()
      return { status: res.status, body: text }
    } catch (e) {
      // 中止（超时）与网络错误分开说：一个能重试，一个要改配置
      if (ctl.signal.aborted) throw new AiError('network', '超时')
      throw new AiError('network', e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timer)
    }
  },
}

export function pickTransport(): Transport {
  const bridge = nativeBridge as unknown as { httpPost?: unknown } | undefined
  if (typeof window !== 'undefined' && typeof bridge?.httpPost === 'function') {
    return nativeTransport
  }
  return fetchTransport
}

/** 测试用：直接注入一个假传输，把 AI 全链路放进 Node 里跑 */
export function __setTransportForTest(t: Transport | null): void {
  forced = t
}

let forced: Transport | null = null

export function resolvedTransport(): Transport {
  return forced ?? pickTransport()
}
