/** 提示词覆盖层 —— 用户改过的那几块，存在本机 localStorage。
 *
 *  ★ 为什么是「覆盖层」而不是整份拷贝：默认值留在代码里，
 *    代码里改了默认值（比如模型换代后调整口径），没被用户改过的块会跟着变；
 *    被改过的块保持用户的版本。恢复默认 = 删掉那一条覆盖，不是写回旧文本。
 *
 *  ★ 为什么改了能**立刻生效**：prompts.ts 每次调用都现场读 `promptText(id)`，
 *    不缓存渲染结果。缓存键里也带提示词指纹（`promptFingerprint`），
 *    改了文本，旧结果自动不命中 —— 这正是「不用重新打包」的实现方式。
 *
 *  只存本机、不进备份：它是「这台设备怎么问 AI」的设置，和 API Key 同类。
 */
import { ref } from 'vue'
import { hashOf } from './cache'
import { BLOCK_BY_ID, PROMPT_BLOCKS, type PromptBlock } from './prompt-registry'

const KEY = 'wb.ai.prompts.v1'

function load(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const json: unknown = JSON.parse(raw)
    if (!json || typeof json !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [id, text] of Object.entries(json as Record<string, unknown>)) {
      // 只认注册表里还有的块：旧版本删掉的 id 留在 localStorage 里不该复活
      if (BLOCK_BY_ID.has(id) && typeof text === 'string' && text.trim()) out[id] = text
    }
    return out
  } catch {
    return {}
  }
}

/** 用户改过的文本（id → 文本）。直接导出 ref，界面据此显示「已改」。 */
export const promptOverrides = ref<Record<string, string>>(load())

function persist(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(promptOverrides.value))
  } catch {
    /* 存不下（隐私模式/配额）就当这次没保存；界面上的「已改」标记会消失 */
  }
}

/** 当前生效的模板文本：用户改过的优先，否则用注册表里的默认值。 */
export function promptText(id: string): string {
  const mine = promptOverrides.value[id]
  if (mine != null) return mine
  return BLOCK_BY_ID.get(id)?.text ?? ''
}

export function isEdited(id: string): boolean {
  return promptOverrides.value[id] != null
}

/** 保存一块文本（去掉与默认值相同的项 —— 那等于没改）。 */
export function setPrompt(id: string, text: string): void {
  const norm = text.replace(/\r\n/g, '\n')
  const def = BLOCK_BY_ID.get(id)?.text ?? ''
  const next = { ...promptOverrides.value }
  if (!norm.trim() || norm === def) delete next[id]
  else next[id] = norm
  promptOverrides.value = next
  persist()
}

export function resetPrompt(id: string): void {
  const next = { ...promptOverrides.value }
  delete next[id]
  promptOverrides.value = next
  persist()
}

export function resetAll(): void {
  promptOverrides.value = {}
  persist()
}

/** 把 `{{变量}}` 换成实际值。没给值的变量留空（保存时已经拦过）。 */
export function renderPrompt(id: string, vars: Record<string, string>): string {
  return promptText(id).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? '')
}

/** 保存前的检查：必需变量不能少、不能出现注册表以外的变量名（防手滑打错）。 */
export function validatePrompt(id: string, text: string): string | null {
  const block = BLOCK_BY_ID.get(id)
  if (!block) return '未知的提示词'
  if (!text.trim()) return '内容不能为空'
  const known = new Set(block.vars.map((v) => v.name))
  const used = new Set<string>()
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1])
  const unknown = [...used].filter((n) => !known.has(n))
  if (unknown.length) return `不认识的变量：${unknown.map((n) => `{{${n}}}`).join('、')}`
  const missing = block.required.filter((n) => !used.has(n))
  if (missing.length) return `缺少必需变量：${missing.map((n) => `{{${n}}}`).join('、')}`
  return null
}

/** 提示词指纹 —— 缓存键的一部分：文本变了，旧缓存自动作废。
 *
 *  用「实际发出去的消息」而不是 id：这样连系统消息与用户消息的拼法都算进去了，
 *  任何影响模型输入的改动都会换键。 */
export function promptFingerprint(messages: Array<{ role: string; content: string }>): string {
  return hashOf(messages.map((m) => `${m.role}:${m.content}`).join('\n'))
}

/** 给管理页用的分组：共用块在前，动作模板在后。 */
export function groupedBlocks(): Array<{ title: string; items: PromptBlock[] }> {
  return [
    { title: '共用块', items: PROMPT_BLOCKS.filter((b) => b.vars.length === 0) },
    { title: '动作模板', items: PROMPT_BLOCKS.filter((b) => b.vars.length > 0) },
  ]
}
