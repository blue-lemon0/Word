/** 朗读（单词 / 例句）。
 *
 *  真机走原生 TextToSpeech（WBNative.speak），浏览器开发时退回
 *  Web Speech API。两条路都没有就藏起喇叭 —— 按钮点了没声音，
 *  比没有按钮更糟。
 *
 *  语速固定 0.9：背单词不是听新闻，稍微慢一点才听得清单词边界。
 */
import { nativeBridge } from './bridge'

const RATE = 0.9

/** 当前环境能不能朗读。模块加载时定死 —— 原生桥是同步注入的，不会半路出现。 */
export const speechOn =
  !!nativeBridge?.speak ||
  (typeof window !== 'undefined' && 'speechSynthesis' in window)

export function speakEn(text: string): void {
  const t = text.trim()
  if (!t) return
  if (nativeBridge?.speak) {
    nativeBridge.speak(t, RATE)
    return
  }
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(t)
  u.lang = 'en-US'
  u.rate = RATE
  window.speechSynthesis.speak(u)
}
