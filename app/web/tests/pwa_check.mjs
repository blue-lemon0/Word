/** PWA 装配检查 —— 装到手机上能不能用的前置条件。
 *
 *  这里最容易坏的不是代码，是「引用了但文件不存在」：
 *  manifest 里写了图标、meta 里引了 manifest、index.html 引了 assets，
 *  少一个文件的表现是「装不上」或「白屏」，而且只有真机才看得到。
 *  所以每次构建后机械查一遍：
 *   1. dist/index.html 引用的本地文件都在
 *   2. manifest 合法、字段齐全、引用的图标都在
 *   3. sw.js 语法能过（它不进打包，错了不会在构建时报出来）
 *   4. 关键 meta 齐全（standalone / apple 那套 / theme-color）
 *
 *  跑法（仓库根）：node app/web/tests/pwa_check.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(HERE, '..', 'dist')
const PUBLIC = path.resolve(HERE, '..', 'public')

let bad = 0
function ok(cond, msg, detail = '') {
  if (cond) console.log(`  PASS  ${msg}`)
  else {
    bad++
    console.log(`  FAIL  ${msg}${detail ? '  → ' + detail : ''}`)
  }
}

if (!existsSync(DIST)) {
  console.error('没有 dist/ —— 先 cd app/web && npm run build')
  process.exit(1)
}

const read = (p) => readFileSync(p, 'utf8')

/* 1. index.html 引用的本地资源都在 */
const html = read(path.join(DIST, 'index.html'))
const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+|\/[^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^https?:/.test(u) && !u.startsWith('data:'))
const missingRefs = refs.filter((u) => !existsSync(path.join(DIST, u.replace(/^\.\//, '').replace(/^\//, ''))))
ok(missingRefs.length === 0, `index.html 引用的 ${refs.length} 个本地资源都在`, missingRefs.join(', '))

/* 2. manifest */
const mPath = path.join(DIST, 'manifest.webmanifest')
ok(existsSync(mPath), 'manifest.webmanifest 已生成（没被 .gitignore 吃掉）')
let mf = {}
try {
  mf = JSON.parse(read(mPath))
  ok(true, 'manifest 是合法 JSON')
} catch (e) {
  ok(false, 'manifest 是合法 JSON', e.message)
}
ok(mf.display === 'standalone', `display=standalone（当前 ${mf.display}）—— 不然装完还有地址栏`)
ok(!!mf.name && !!mf.short_name, `有 name/short_name（${mf.short_name}）`)
ok(!!mf.theme_color && !!mf.background_color, '有 theme_color / background_color')
ok((mf.icons ?? []).length >= 2, `图标 ≥2 个（${(mf.icons ?? []).length}）`)
ok((mf.icons ?? []).some((i) => i.purpose === 'maskable'), '有 maskable 图标（Android 自适应图标）')
const iconSizes = (mf.icons ?? []).map((i) => i.sizes)
ok(
  iconSizes.includes('192x192') && iconSizes.includes('512x512'),
  '有 192 与 512（Chrome 安装的硬性要求）',
  iconSizes.join(','),
)
const missIcons = (mf.icons ?? []).filter((i) => !existsSync(path.join(DIST, i.src))).map((i) => i.src)
ok(missIcons.length === 0, 'manifest 引用的图标文件都存在', missIcons.join(', '))
ok(
  (mf.shortcuts ?? []).length > 0 && (mf.shortcuts ?? []).every((s) => existsSync(path.join(DIST, s.icons?.[0]?.src ?? 'x'))),
  '长按图标的快捷入口（训练/词库）图标都在',
)

/* 3. sw.js：它在 public/ 里原样拷贝，不参与构建，语法错了没人拦 */
const sw = read(path.join(DIST, 'sw.js'))
let swOk = true
let swErr = ''
try {
  // classic worker script：用 Function 构造做语法检查
  new Function(sw)
} catch (e) {
  swOk = false
  swErr = e.message
}
ok(swOk, 'sw.js 语法有效', swErr)
ok(sw.includes('addEventListener(\'fetch\''), 'sw.js 处理了 fetch（有缓存策略）')
ok(/const CACHE = 'wordbank-v\d+'/.test(sw), 'sw.js 带版本号缓存名（升级时好清）')

/* 4. iOS / Android 的 meta */
const need = [
  ['manifest 引用', 'rel="manifest"'],
  ['theme-color', 'name="theme-color"'],
  ['android 全屏', 'mobile-web-app-capable'],
  ['iOS 全屏', 'apple-mobile-web-app-capable'],
  ['iOS 标题', 'apple-mobile-web-app-title'],
  ['iOS 图标', 'rel="apple-touch-icon"'],
  ['viewport-fit（刘海屏安全区）', 'viewport-fit=cover'],
]
const missMeta = need.filter(([, k]) => !html.includes(k)).map(([, k]) => k)
ok(missMeta.length === 0, `关键 meta 齐全（${need.length} 项）`, missMeta.join(', '))

/* 5. public 里的源文件也在（sw/图标是从这里生成的，别只留 dist） */
const srcFiles = ['sw.js', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']
const missSrc = srcFiles.filter((f) => !existsSync(path.join(PUBLIC, f)))
ok(missSrc.length === 0, 'public/ 下的源文件都在（dist 可随时重建）', missSrc.join(', '))

/* 6. 种子包不能太大：它会被 SW 缓存，太大会撑爆配额 */
const seed = path.join(PUBLIC, 'seed.json')
if (existsSync(seed)) {
  const kb = Math.round(statSync(seed).size / 1024)
  ok(kb < 3000, `种子包 ${kb} KB（离线首启要缓存它，太大会顶配额）`)
} else {
  ok(false, 'public/seed.json 在位（离线首启要靠它灌词库）')
}

console.log(bad ? `\n${bad} 处失败` : '\nPWA 装配检查：全绿')
process.exitCode = bad ? 1 : 0