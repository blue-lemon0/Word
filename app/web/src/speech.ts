/** 朗读（单词 / 例句）。
 *
 *  优先级：神经 TTS（在线合成，缓存后零延迟）→ 原生系统 TTS →
 *  Web Speech API。神经这条路没配 key 或没网时静默回退，用户无感。
 *  真机走原生 TextToSpeech（WBNative.speak），浏览器开发时退回
 *  Web Speech API。两条路都没有就藏起喇叭 —— 按钮点了没声音，
 *  比没有按钮更糟。
 *
 *  语速固定 0.9：背单词不是听新闻，稍微慢一点才听得清单词边界。
 */
import { nativeBridge } from './bridge'
import { neuralPossible, speakNeural, stopNeural } from './ai/ttsNeural'

const RATE = 0.9

/** 当前环境能不能朗读。模块加载时定死 —— 原生桥是同步注入的，不会半路出现。 */
export const speechOn =
  !!nativeBridge?.speak ||
  (typeof window !== 'undefined' && 'speechSynthesis' in window)

function speakLegacy(t: string): void {
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

export function speakEn(text: string): void {
  const t = text.trim()
  if (!t) return
  stopNeural()
  // 没配神经 TTS 时走同步快路径：行为与探索前逐字节一致，不引入任何异步。
  if (!neuralPossible()) {
    speakLegacy(t)
    return
  }
  // 神经 TTS 优先：命中缓存立刻播；未命中等 1.2s，等不到就让系统 TTS 先开口
  // （音频到了只进缓存，下一遍起就是它了），绝不让人干等。
  void speakNeural(t, 1200).then((ok) => {
    if (!ok) speakLegacy(t)
  })
}
