/** 聊天客户端 —— 只做一件事：把 messages 发出去，把文本拿回来。
 *
 *  ★ 这里**不认识** DeepSeek：协议是 OpenAI 兼容的 `/chat/completions`，
 *    换供应商/换模型只改配置，不改代码。真正与 DeepSeek 有关的只有
 *    `config.ts` 里的一个默认值。
 *
 *  ★ 请求体刻意很小：不带 tools、不带 stream、temperature 默认 0.2 ——
 *    这个 app 要的是「稳定地按格式回答」，不是发挥。max_tokens 是硬闸门。
 */
import { loadConfig } from './config'
import { resolvedTransport } from './transport'
import { AiError, type AiUsage } from './types'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface ChatReply {
  text: string
  usage?: AiUsage
}

/** 把配置里的根地址补成完整的 completions 端点（用户可能填 `/ai` 或带 `/v1`）。 */
export function endpoint(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(b)) return b
  return `${b}/chat/completions`
}

const TIMEOUT_MS = 90_000

/**
 * 发一次聊天请求。
 *
 *  ★ `json` 模式（response_format）不是所有兼容网关都支持：被拒时
 *    **自动去掉这个字段重试一次** —— 否则「换了个网关就整个功能不能用」，
 *    而错误信息只会告诉你 400。
 */
export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; temperature?: number } = {},
): Promise<ChatReply> {
  const cfg = loadConfig()
  if (!cfg.apiKey.trim()) throw new AiError('no-config', '没有 API Key')
  const t = resolvedTransport()
  const url = endpoint(cfg.baseUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey.trim()}`,
  }

  const base = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? cfg.temperature,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    stream: false,
  }

  const attempts = opts.json ? [{ ...base, response_format: { type: 'json_object' } }, base] : [base]

  let last: { status: number; body: string } | null = null
  for (const payload of attempts) {
    const res = await t.postJson(url, headers, JSON.stringify(payload), TIMEOUT_MS)
    last = res
    if (res.status === 200) {
      return readReply(res.body)
    }
    // 只有「不认识 response_format」这一种 400 值得重试
    const body = res.body.toLowerCase()
    if (!(res.status === 400 && body.includes('response_format'))) break
  }

  const status = last?.status ?? 0
  let detail = last?.body ?? ''
  try {
    const j = JSON.parse(detail) as { error?: { message?: string } }
    detail = j.error?.message ?? detail
  } catch {
    /* 不是 JSON 就原样截断 */
  }
  throw new AiError('http', detail.slice(0, 300) || 'HTTP 错误', status)
}

function readReply(body: string): ChatReply {
  let j: unknown
  try {
    j = JSON.parse(body)
  } catch {
    throw new AiError('parse', '回复不是 JSON')
  }
  const o = j as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  const text = o.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) {
    throw new AiError('refused', '回复是空的')
  }
  const u = o.usage
  return {
    text,
    usage:
      u && typeof u.total_tokens === 'number'
        ? {
            prompt: u.prompt_tokens ?? 0,
            completion: u.completion_tokens ?? 0,
            total: u.total_tokens,
          }
        : undefined,
  }
}

/** 连通性测试：一次最小请求，界面上「测试连接」用它。
 *  只花几十个 token —— 比「点一次真实功能再说」便宜得多。 */
export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await chat(
      [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'ping' },
      ],
      { maxTokens: 8, temperature: 0 },
    )
    return { ok: true, detail: `通了（回复：${r.text.trim().slice(0, 20)}）` }
  } catch (e) {
    return { ok: false, detail: e instanceof AiError ? e.message : String(e) }
  }
}
