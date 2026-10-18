/** AI 配置 —— 只存本机（localStorage），**不进备份**。
 *
 *  ★ 为什么不进备份：备份是用来发给别人、或换手机时搬家的文件。
 *    把 API key 塞进去，等于每次导出都在复制一份密钥 —— 而备份文件
 *    经常通过微信 / 邮件流转。密钥属于「这台设备」，不属于「这份数据」。
 *
 *  ★ 为什么默认关闭：不配也能完整使用这个 app（离线背单词是主体）。
 *    AI 是一个**可选增强**，没配的时候入口不出现，而不是让人点进去
 *    看到「请先配置」。
 *
 *  ★ 为什么 baseUrl 可改：DeepSeek 只是当下的选择。任何 OpenAI 兼容的
 *    聊天接口（/chat/completions）都能直接用，换供应商只改这一行。
 *    代码里不出现 "deepseek" 的判断，只有默认值里出现一次。
 */
import { ref } from 'vue'

export interface AiConfig {
  /** 总开关：关掉时所有 AI 入口隐藏 */
  enabled: boolean
  /** 接口根地址。桌面开发时填 `/ai`（vite 代理，绕开 CORS） */
  baseUrl: string
  apiKey: string
  /** 模型名。DeepSeek 的 `deepseek-chat` 是便宜档 */
  model: string
  /** 单次回复上限 —— 省钱的硬闸门 */
  maxTokens: number
  temperature: number
}

export const DEFAULT_CONFIG: AiConfig = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  maxTokens: 1400,
  temperature: 0.2,
}

const KEY = 'wb.ai.config'

/** 测试注入（Node 里没有 localStorage）。运行时永远是 null。 */
let override: AiConfig | null = null

export function __setConfigForTest(c: AiConfig | null): void {
  override = c
}

export function loadConfig(): AiConfig {
  if (override) return { ...override }
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const o = JSON.parse(raw) as Partial<AiConfig>
    // 逐字段兜底：旧版本存的配置缺字段时不该把界面搞崩
    return {
      enabled: o.enabled === true,
      baseUrl: typeof o.baseUrl === 'string' && o.baseUrl ? o.baseUrl : DEFAULT_CONFIG.baseUrl,
      apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
      model: typeof o.model === 'string' && o.model ? o.model : DEFAULT_CONFIG.model,
      maxTokens: Number.isFinite(o.maxTokens) ? Number(o.maxTokens) : DEFAULT_CONFIG.maxTokens,
      temperature: Number.isFinite(o.temperature)
        ? Number(o.temperature)
        : DEFAULT_CONFIG.temperature,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(c: AiConfig): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(c))
  refreshAiReady()
}

/* ── 「现在能不能用 AI」是一个**跨页面的共享状态** ──
 *
 *  ★ 为什么不是每个页面自己 `isConfigured()`：配置是在「更多」页改的，
 *    而入口在词条页/意思页。各自算一次的结果是：配置完回到词条页，
 *    按钮还是不出现（那个页面是重新挂载的，或者干脆被缓存着）——
 *    用户会以为「保存没生效」。
 *    一个共享 ref 让「配置一变，各页面的入口立刻跟着变」。
 */
export const aiReady = ref(isConfigured())

export function refreshAiReady(): void {
  aiReady.value = isConfigured()
}


/** 配好了没有：开着 + 有 key。界面靠它决定「显不显示 AI 入口」。 */
export function isConfigured(c: AiConfig = loadConfig()): boolean {
  return c.enabled && !!c.apiKey.trim() && !!c.baseUrl.trim() && !!c.model.trim()
}

/** 把 key 遮起来给界面看（只露头尾，避免肩窕/录屏泄露） */
export function maskKey(k: string): string {
  if (!k) return ''
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 4)}••••${k.slice(-4)}`
}
