/** 朗读（单词 / 例句）。
 *
 *  优先级：在线神经 TTS（Edge 免 key 主力 + 硅基流动备用，并行竞速，
 *  缓存后零延迟）→ 原生系统 TTS → Web Speech API。在线这条路没桥没 key
 *  或连续失败 3 次（熔断）时静默回退，用户无感。
 *
 *  等待策略（用户拍板）：能等就等 —— 点了喇叭就等在线合成到货，
 *  期间 ttsWaiting 变 true（喇叭变色提示）；等到就播，等不到才退回
 *  系统 TTS。
 *
 *  语速固定 0.9：背单词不是听新闻，稍微慢一点才听得清单词边界。
 */
import { ref } from 'vue'
import { nativeBridge } from './bridge'
import { onlineAlive, speakOnline, stopNeural } from './ai/ttsNeural'

/** 在线合成等待中：喇叭据此变色。true→false 的边沿就是「出声或让位」的时刻。 */
export const ttsWaiting = ref(false)

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
  // 无桥无 key（纯浏览器 dev）或熔断已开：同步快路径，不引入任何异步
  if (!onlineAlive()) {
    speakLegacy(t)
    return
  }
  // 能等就等：喇叭变色进等待态，在线合成到货就播神经音色；
  // 全部失败/硬超时才退回系统 TTS（连续 3 次后熔断，下回直接走快路径）
  ttsWaiting.value = true
  void speakOnline(t).then((ok) => {
    ttsWaiting.value = false
    if (!ok) speakLegacy(t)
  })
}
