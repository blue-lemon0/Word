/** 生成 PWA 图标（可重跑）。
 *
 *  ★ 图标是**位图母版**，不在这里画：母版放在
 *    `public/icon-master.png`（1024，满幅方形、四周留白已裁掉、圆角外涂满深蓝）
 *    与 `public/icon-glyph.png`（1024，透明底，只有白色纸片与蓝/灰色块）。
 *    换设计就换这两个母版，然后 `npm run icons` 重出全套。
 *
 *  产出（public/ 下）：
 *   icon-64.png / icon-192.png / icon-512.png   普通图标（深蓝底 + 图形）
 *   icon-maskable-512.png                      Android 自适应（图形收进安全区）
 *   apple-touch-icon.png                       iOS 主屏（180，不透明、无圆角，iOS 自己切）
 *   favicon.svg                                内嵌 64px PNG 的矢量 favicon
 */
import sharp from 'sharp'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'public')
mkdirSync(OUT, { recursive: true })

/** 母版的深蓝底色，与 Android 自适应图标的 background 同一个值 */
const NAVY = '#1f2a44'

/** 普通图标：深蓝满幅 + 图形（ratio 控制图形占多大） */
async function flat(size, ratio, file) {
  const inner = Math.max(1, Math.round(size * ratio))
  const glyph = await sharp(path.join(OUT, 'icon-master.png')).resize(inner, inner).toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([
      { input: glyph, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) },
    ])
    .png()
    .toFile(path.join(OUT, file))
}

/** 只有图形（透明底）叠在深蓝上：maskable 要把图形收进安全区 */
async function maskable(size, ratio, file) {
  const inner = Math.max(1, Math.round(size * ratio))
  const glyph = await sharp(path.join(OUT, 'icon-glyph.png')).resize(inner, inner).toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([
      { input: glyph, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) },
    ])
    .png()
    .toFile(path.join(OUT, file))
}

await flat(64, 0.86, 'icon-64.png')
await flat(180, 0.8, 'apple-touch-icon.png')
await flat(192, 0.8, 'icon-192.png')
await flat(512, 0.8, 'icon-512.png')
await maskable(512, 0.62, 'icon-maskable-512.png')

// favicon：内嵌一张 64px PNG（比手画 SVG 更接近真实图标）
const fav = await sharp(path.join(OUT, 'icon-64.png')).png().toBuffer()
writeFileSync(
  path.join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><image width="64" height="64" href="data:image/png;base64,${fav.toString('base64')}"/></svg>\n`,
)

console.log('图标已生成：icon-64/192/512、maskable、apple-touch、favicon.svg')
