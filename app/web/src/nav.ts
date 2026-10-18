/** 页面返回 —— 顶栏那个箭头。
 *
 *  一句话口径：**箭头 = 手机的返回键**，再加一个「没有上一屏时去哪」的兜底。
 *  之前两边各写各的，于是意思页 push 回单词页、单词页 back() 回意思页，
 *  叠成一个闭环：意思页 → 单词页 → 返回 → 又回意思页（真机实测：
 *  两次返回后 URL 原封不动地回到义项页）。统一走这里之后，
 *  无论怎么点都只会往回走，和按系统返回键的结果一模一样。
 *
 *  三种不能只靠 back() 的情况：
 *   1. **没有上一屏**：书签 / 桌面图标直接进来的深链，back() 是空操作，
 *      表现为「按了返回像坏了」。判断用 history.length —— 每次 push 都会
 *      +1，replace 不动它，所以长度为 1 就是停在第一屏。
 *   2. **上一屏就是自己**：合并/删除义项后 replace 回单词页，历史里会留下
 *      两条一模一样的单词页。这时 back() 会「退到一模一样的页面」，
 *      用户看到的就是又没反应。
 *   3. **上一屏和自己是同一屏、只是 query 不同**（`/train?scope=due` vs
 *      `/train?scope=new`）：back() 之后 URL 变了、屏幕没变，同样像没反应。
 *      所以比较时**只比 path**，不比 fullPath。
 *
 *  ★ 最后一层保险：back() 是个不返回结果的异步动作 —— 上一屏被 replace 掉、
 *    或 WebView 把历史条目合并了的时候，它**什么都不做**。
 *    所以这里加了计时器兜底：400ms 后还停在原来那屏，就自己去 parent。
 *    宁可多退一层（parent 是明确的去处），也不能让按钮看起来坏了。
 */
import type { Router } from 'vue-router'

/** 连点防抖：350ms 内只认第一次。
 *
 *  ★ 返回键的另一个「没反应」来源是**连点**：第一次点了已经在退，
 *    第二次落在退场动画里 —— 有的会退两层，有的什么都不做。
 *    统一成「最短间隔 350ms」，行为就只剩一种：退一层。
 */
let lastGoBackAt = 0

/** 只取 path 部分（去掉 ?query 与 #hash）。导出给测试用。 */
export function pathOf(full: string): string {
  const i = full.indexOf('?')
  const j = full.indexOf('#')
  const cut = Math.min(i < 0 ? full.length : i, j < 0 ? full.length : j)
  return full.slice(0, cut)
}

/** 回上一屏；退不了、上一屏是自己、或 back() 没动时，去 parent。 */
export function goBack(router: Router, parent: string): void {
  const at = Date.now()
  if (at - lastGoBackAt < 350) return
  lastGoBackAt = at

  const cur = router.currentRoute.value.path
  const state = router.options.history.state as { back?: string | null } | null
  const from = typeof state?.back === 'string' ? state.back : ''

  // 1) 第一屏：没有上一屏可退
  if (window.history.length <= 1) {
    void router.replace(parent)
    return
  }
  // 2) 上一屏和自己是同一屏（只差 query/hash）：退过去也不会有反应
  if (from && pathOf(from) === cur) {
    void router.replace(parent)
    return
  }

  const before = router.currentRoute.value.fullPath
  router.back()
  // 3) 兜底：back() 空转时自己退到 parent
  setTimeout(() => {
    if (router.currentRoute.value.fullPath === before) void router.replace(parent)
  }, 400)
}
