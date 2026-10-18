/** 生成 Android 各密度的启动图标。
 *
 *  源图是 web/public/icon-512.png（由 scripts/make_icons.mjs 生成），
 *  这里只做尺寸变换 —— 图标本体是机器产物，不手绘、不在 Android 工程里另存一份。
 */
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const APP = path.resolve(WEB, '..')
const SRC = path.join(WEB, 'public', 'icon-512.png')
/** Android 工程在 app/android（与 web 平级），不在 web 里面 */
const RES = path.join(APP, 'android', 'app', 'src', 'main', 'res')

const DENSITIES = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]

for (const [dir, px] of DENSITIES) {
  mkdirSync(path.join(RES, dir), { recursive: true })
  await sharp(SRC).resize(px, px).png().toFile(path.join(RES, dir, 'ic_launcher.png'))
  console.log('图标', dir, `${px}×${px}`)
}