/** 轻提示 —— 全局单例，任何页面 `toast('已保存')` 即可。 */
import { ref } from 'vue'

export const toastMsg = ref('')
/* 位置：默认贴底（不挡内容）；「必须被看见」的提示传 center ——
   比如「先作答」这种点了没反应的回应，压在底栏边上容易被忽略（用户反馈）。 */
export const toastCenter = ref(false)

let timer: ReturnType<typeof setTimeout> | null = null

export function toast(msg: string, ms = 1900, center = false): void {
  toastMsg.value = msg
  toastCenter.value = center
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    toastMsg.value = ''
    timer = null
  }, ms)
}