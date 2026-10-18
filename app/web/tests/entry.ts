/** 测试入口：把 src 下的模块汇总导出，供 tests/flow_smoke.mjs 打包后 import。
 *  只为测试存在，运行时不被任何页面引用。
 */
export * as db from '../src/db'
export * as edit from '../src/edit'
export * as importer from '../src/importer'
export * as backup from '../src/backup'
export * as quiz from '../src/quiz'
export * as flags from '../src/flags'
export * as bundleImport from '../src/import'
export * as lookup from '../src/lookup'
export * as ai from '../src/ai/index'
export * as composables from '../src/composables'
export * as nav from '../src/nav'
export * as spell from '../src/spell'
