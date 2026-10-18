/** 生成 PWA 图标（可重跑）。
 *
 *  为什么要有这个脚本：图标是机器产物，不该手工画。改设计就改这里的
 *   DRAW 段，然后 `npm run icons` 重出全套。
 *
 *  产出（public/ 下）：
 *   icon-192.png / icon-512.png      普通图标（圆角方块底 + 字母标记）
 *   icon-maskable-512.png           Android 自适应图标（安全区内收，边缘满幅）
 *   apple-touch-icon.png            iOS 主屏图标（180×180，不透明、无圆角，iOS 自己切）
 *   favicon.svg                      矢量 favicon
 */
import sharp from 'sharp'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', 'public')
mkdirSync(OUT, { recursive: true })

/** 画一个图标：底色渐变 + 一个大字母 + 下面一行细横条（表示「词条」）。
 *  安全区参数 safe=1 表示满幅铺（maskable 用），safe<1 时内容缩进安全区。 */
function svg({ size, text, sub = true, safe = 1, radius = 0.22 }) {
  const r = size * radius
  const bg = `<defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4f46e5"/><stop offset="55%" stop-color="#5b7cfa"/>
        <stop offset="100%" stop-color="#7c5cff"/></linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="rgba(255,255,255,0.30)"/>
        <stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient>
    </defs>`
  // maskable：内容缩到 60% 安全区内（Android 可能裁成任何形状）
  const scale = safe
  const fs = size * 0.42 * scale
  const subW = size * 0.5 * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  <circle cx="${size * 0.26}" cy="${size * 0.22}" r="${size * 0.46}" fill="url(#glow)"/>
  <text x="50%" y="${size / 2 + fs * 0.36}" text-anchor="middle"
        font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${fs}"
        font-weight="700" fill="#fff" letter-spacing="${-fs * 0.04}">${text}</text>
  ${sub ? `<rect x="50%" y="${size / 2 + fs * 0.72}" width="${subW}" height="${size * 0.045 * scale}" rx="${size * 0.02}" fill="rgba(255,255,255,0.7)"/>` : ''}
</svg>`
}

const jobs = [
  ['icon-192.png', 192, { text: 'A', safe: 0.86 }],
  ['icon-512.png', 512, { text: 'A', safe: 0.86 }],
  // maskable：满幅底 + 内容缩到中间 60%
  ['icon-maskable-512.png', 512, { text: 'A', safe: 0.6 }],
  // iOS 自己切圆角，所以画成方的满幅
  ['apple-touch-icon.png', 180, { text: 'A', safe: 0.86, radius: 0 }],
  ['icon-64.png', 64, { text: 'A', safe: 0.86 }],
]

for (const [name, size, opt] of jobs) {
  const buf = Buffer.from(svg({ size, ...opt }))
  await sharp(buf).png({ compressionLevel: 9 }).toFile(path.join(OUT, name))
  console.log('写出', name, `${size}×${size}`)
}

// 矢量 favicon
const favicon = svg({ size: 64, text: 'A', safe: 0.86 })
writeFileSync(path.join(OUT, 'favicon.svg'), favicon, 'utf8')
console.log('写出 favicon.svg')