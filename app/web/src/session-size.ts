/** 每组题量 —— 只影响「复习 / 学习」整轮，不影响随便刷。 */
import { ref } from 'vue'

const KEY = 'wb.sessionSize'

export const SESSION_SIZES = [10, 20] as const
export type SessionSize = (typeof SESSION_SIZES)[number]

function read(): SessionSize {
  try {
    return Number(localStorage.getItem(KEY)) === 10 ? 10 : 20
  } catch {
    return 20
  }
}

export const sessionSize = ref<SessionSize>(read())

export function setSessionSize(n: SessionSize): void {
  sessionSize.value = n
  try {
    localStorage.setItem(KEY, String(n))
  } catch {
    /* 隐私模式下写不进去，本次仍然生效 */
  }
}
