/** 轻提示 —— 全局单例，任何页面 `toast('已保存')` 即可。 */
import { ref } from 'vue'

export const toastMsg = ref('')

let timer: ReturnType<typeof setTimeout> | null = null

export function toast(msg: string, ms = 1900): void {
  toastMsg.value = msg
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    toastMsg.value = ''
    timer = null
  }, ms)
}