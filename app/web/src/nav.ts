/** 页面返回 —— 顶栏那个箭头。
 *
 *  一句话口径：**箭头 = 手机的返回键**，再加一个「没有上一屏时去哪」的兜底。
 *  之前两边各写各的，于是意思页 push 回单词页、单词页 back() 回意思页，
 *  叠成一个闭环：意思页 → 单词页 → 返回 → 又回意思页（真机实测：
 *  两次返回后 URL 原封不动地回到义项页）。统一走这里之后，
 *  无论怎么点都只会往回走，和按系统返回键的结果一模一样。
 *
 *  两种不能 back() 的情况：
 *   1. **没有上一屏**：书签 / 桌面图标直接进来的深链，back() 是空操作，
 *      表现为「按了返回像坏了」。判断用 history.length —— 每次 push 都会
 *      +1，replace 不动它，所以长度为 1 就是停在第一屏。
 *   2. **上一屏就是自己**：合并/删除义项后 replace 回单词页，历史里会留下
 *      两条一模一样的单词页（见 SensePage 的 toWordPage）。这时 back()
 *      会「退到一模一样的页面」，用户看到的就是又没反应。
 */
import type { Router } from 'vue-router'

/** 回上一屏；退不了或上一屏就是自己时，去 parent。 */
export function goBack(router: Router, parent: string): void {
  const cur = router.currentRoute.value.path
  const prev = router.options.history.state.back
  const from = typeof prev === 'string' ? prev : ''
  if (window.history.length > 1 && from !== cur) router.back()
  else router.replace(parent)
}