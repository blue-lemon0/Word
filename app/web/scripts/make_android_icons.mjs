/** 生成 Android 各密度的启动图标（含自适应图标）。
 *
 *  母版是 web/public 下的两张位图（由 scripts/make_icons.mjs 的同一份素材派生）：
 *    icon-master.png  1024，满幅方形、四周留白已裁、圆角外涂满深蓝 → 旧式 ic_launcher
 *    icon-glyph.png   1024，透明底、只有图形                      → 自适应图标前景层
 *
 *  ★ 自适应图标必须拆两层：前景只能有图形，底色交给 background 层。
 *    直接把"满幅方形图标"当前景，圆角外的底色会被系统再套一层遮罩，看起来脏。
 */
import sharp from 'sharp'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const APP = path.resolve(WEB, '..')
const PUB = path.join(WEB, 'public')
const RES = path.join(APP, 'android', 'app', 'src', 'main', 'res')
const NAVY = '#1f2a44'

/** 旧式图标（方形满幅）：48 / 72 / 96 / 144 / 192 */
const LEGACY = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]

/** 自适应图标前景层：108dp 的 1x/1.5x/2x/3x/4x */
const FOREGROUND = [
  ['mipmap-mdpi', 108],
  ['mipmap-hdpi', 162],
  ['mipmap-xhdpi', 216],
  ['mipmap-xxhdpi', 324],
  ['mipmap-xxxhdpi', 432],
]

for (const [dir, px] of LEGACY) {
  mkdirSync(path.join(RES, dir), { recursive: true })
  await sharp(path.join(PUB, 'icon-master.png'))
    .resize(px, px)
    .png()
    .toFile(path.join(RES, dir, 'ic_launcher.png'))
  await sharp(path.join(PUB, 'icon-master.png'))
    .resize(px, px)
    .png()
    .toFile(path.join(RES, dir, 'ic_launcher_round.png'))
  console.log('图标', dir, `${px}×${px}`)
}

for (const [dir, px] of FOREGROUND) {
  mkdirSync(path.join(RES, dir), { recursive: true })
  // 图形收进 66% 安全区：自适应图标可能被裁成圆形/水滴形
  const inner = Math.round(px * 0.66)
  const glyph = await sharp(path.join(PUB, 'icon-glyph.png')).resize(inner, inner).toBuffer()
  await sharp({ create: { width: px, height: px, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, top: Math.round((px - inner) / 2), left: Math.round((px - inner) / 2) }])
    .png()
    .toFile(path.join(RES, dir, 'ic_launcher_foreground.png'))
  console.log('自适应前景', dir, `${px}×${px}`)
}

// 自适应图标描述（旧 Android 用 PNG，8.0+ 用这两份 xml）
const ANYDPI = path.join(RES, 'mipmap-anydpi-v26')
mkdirSync(ANYDPI, { recursive: true })
const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`
writeFileSync(path.join(ANYDPI, 'ic_launcher.xml'), xml)
writeFileSync(path.join(ANYDPI, 'ic_launcher_round.xml'), xml)

// 背景色（与母版同一个深蓝）
const colors = path.join(RES, 'values', 'colors.xml')
if (existsSync(colors)) {
  const s = readFileSync(colors, 'utf8')
  if (!s.includes('ic_launcher_background')) {
    writeFileSync(
      colors,
      s.replace('</resources>', `    <color name="ic_launcher_background">${NAVY}</color>\n</resources>`),
    )
    console.log('背景色已写入 colors.xml')
  }
}
