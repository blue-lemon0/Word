import pkg from '../package.json'

/** 应用名与版本 —— 版本号只在 package.json 里写一次。
 *
 *  ★ 发布流水线会先改 package.json 的 version，再构建前端；
 *    界面上的品牌块、备份头、更新检查都从这里取，避免三处各写一个版本。
 */
export const APP_NAME = '极简单词'
export const APP_NAME_EN = 'Jíjiǎn Dāncí'
export const APP_VERSION = pkg.version
