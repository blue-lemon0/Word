/** 一条命令：构建前端 → 打进 APK → 装到已连接的手机。
 *
 *      npm run apk                     debug：构建 + 安装
 *      npm run apk -- --no-install     debug：只出包不装
 *      npm run apk:release             release：签名 APK + AAB，不自动安装
 *
 *  debug 产物在 app/android/app/build/outputs/apk/debug/app-debug.apk；
 *  release 产物在 app/android/app/build/outputs/apk/release/ 和 bundle/release/。
 *
 *  它做的事（顺序不能换）：
 *    1. vite build（没有 dist 才跑）
 *    2. dist → app/android/app/src/main/assets（先清空，避免残留上个版本）
 *    3. 图标各密度
 *    4. gradle assembleDebug / assembleRelease（release 另出 AAB）
 *    5. debug 包 adb install（release 需显式 --install）
 *
 *  第 2 步为什么先清空：APK 里装的是**上个版本的页面**这种错，只有
 *  「换手机后打开发现功能不对、重新装就好了」的诡异现象，因为漏删的文件
 *  在资源压缩后根本看不出来。宁可多花 200 ms 清一次。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync as exec } from 'node:child_process'
import sharp from 'sharp'

/**
 * 从 APK（就是个 zip）里读一个文本条目的内容。
 * 用 PowerShell 的 Expand-Archive 解到临时目录再读 —— 不为此加依赖。
 * 读不到就返回 null（调用方会跳过自检，而不是把构建搞崩）。
 */
function readApkEntry(apkPath, entry) {
  const tmp = path.join(HERE, '.apk-peek', path.basename(entry))
  try {
    rmSync(path.dirname(tmp), { recursive: true, force: true })
    mkdirSync(path.dirname(tmp), { recursive: true })
    // PowerShell 的单引号里反斜杠是字面量，不能再转义；路径里的反斜杠要保留原样。
    // 失败不阻断构建 —— 自检是保险，不是主流程。
    exec(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -A System.IO.Compression.FileSystem;` +
          `$z=[IO.Compression.ZipFile]::OpenRead('${apkPath}');` +
          `$e=$z.Entries|Where-Object {$_.FullName -eq '${entry}'};` +
          `if($e){[IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${tmp}',$true)};` +
          `$z.Dispose()`,
      ],
      { stdio: 'ignore' },
    )
    return existsSync(tmp) ? execFileSync('powershell', ['-NoProfile', '-Command', `[IO.File]::ReadAllText('${tmp}')`], { encoding: 'utf8' }) : null
  } catch {
    return null
  } finally {
    rmSync(path.dirname(tmp), { recursive: true, force: true })
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const APP = path.resolve(WEB, '..')
/** Android 工程与 web 平级（app/android），不在 web 里面 */
const ANDROID = path.join(APP, 'android')
const ASSETS = path.join(ANDROID, 'app', 'src', 'main', 'assets')

const SDK = process.env.ANDROID_HOME ?? 'D:/software/Android/Sdk'
const JDK = process.env.JAVA_HOME ?? 'D:/software/Android/Android Studio/jbr'
const ADB = path.join(SDK, 'platform-tools', 'adb.exe')

const release = process.argv.includes('--release')
const buildAab = release && process.argv.includes('--aab')
const install = !process.argv.includes('--no-install') && (!release || process.argv.includes('--install'))
const log = (m) => console.log(`· ${m}`)

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else out.push({ path: full, size: statSync(full).size })
  }
  return out
}

/** 找 gradle：用 wrapper 缓存里**版本最高**的发行版。
 *
 *  ★ 为什么不能拿到第一个就用：缓存里会同时躺好几个版本（8.11.1 和 9.4.1），
 *    而 AGP 对 Gradle 有最低版本要求 —— 拿到旧的就是
 *    "Minimum supported Gradle version is X" 这种构建期报错。
 *    按目录名里的版本号排序取最高，新装版本自动生效。 */
function findGradle() {
  const root = path.join(process.env.USERPROFILE, '.gradle', 'wrapper', 'dists')
  if (existsSync(root)) {
    const candidates = []
    for (const d of readdirSync(root)) {
      const dir = path.join(root, d)
      if (!statSync(dir).isDirectory()) continue
      const ver = /gradle-(\d+(?:\.\d+)*)-bin/.exec(d)?.[1]
      for (const sub of readdirSync(dir)) {
        const subDir = path.join(dir, sub)
        if (!statSync(subDir).isDirectory()) continue
        const bat = path.join(subDir, d.replace('-bin', ''), 'bin', 'gradle.bat')
        if (existsSync(bat)) candidates.push({ ver: ver ?? '0', bat })
      }
    }
    candidates.sort((a, b) => compareVer(b.ver, a.ver))
    if (candidates.length) return candidates[0].bat
  }
  const local = path.join(ANDROID, 'gradlew.bat')
  if (existsSync(local)) return local
  throw new Error('找不到 gradle：装过 Android Studio 的机器上，wrapper 缓存里通常有')
}

/** 按段比较 "9.4.1" > "8.11.1"（逐段数值比，不是字符串比） */
function compareVer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function findBuildTool(name) {
  const root = path.join(SDK, 'build-tools')
  if (!existsSync(root)) return null
  const dirs = readdirSync(root)
    .filter((d) => statSync(path.join(root, d)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse()
  for (const d of dirs) {
    const file = path.join(root, d, name)
    if (existsSync(file)) return file
  }
  return null
}

/* 1. 前端产物：**每次都重新构建**，不因为 dist 存在就跳过。
      曾经写成「dist 存在就跳过」，结果把修复之前的旧代码打进了 apk ——
      手机上装的是上个版本，而本机 dev server 上看着一切正常。
      这种错装到手机上极难发现：功能不对 → 重装 → 又不对 → 怀疑人生。
      确实想复用 dist 时用 --skip-web（很少需要）。 */
if (!process.argv.includes('--skip-web')) {
  log('构建前端（vite build）')
  execFileSync('node', [path.join(WEB, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: WEB,
    stdio: 'inherit',
  })
} else if (!existsSync(path.join(WEB, 'dist', 'index.html'))) {
  throw new Error('--skip-web 但 dist 不存在')
}

/* 2. 拷进 assets：放在 assets/ 根，URL /index.html → assets/index.html，
      dist 里的 assets/ 子目录正好对上 vite 打包出的 /assets/xxx.js */
rmSync(ASSETS, { recursive: true, force: true })
mkdirSync(ASSETS, { recursive: true })
cpSync(path.join(WEB, 'dist'), ASSETS, { recursive: true })
// 壳里 assets 本身就是离线的；sw.js 多一层缓存逻辑，反而可能缓存到不该缓存的东西
rmSync(path.join(ASSETS, 'sw.js'), { force: true })
log(`assets 就位：${(walk(ASSETS).reduce((n, f) => n + f.size, 0) / 1024).toFixed(0)} KB`)

/* 3. 图标（源图与 PWA 同源，别在 Android 工程里另存一份） */
const res = path.join(ANDROID, 'app', 'src', 'main', 'res')
for (const [dir, px] of [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]) {
  mkdirSync(path.join(res, dir), { recursive: true })
  await sharp(path.join(WEB, 'public', 'icon-512.png')).resize(px, px).png().toFile(path.join(res, dir, 'ic_launcher.png'))
}
log('图标 5 档已生成')

/* 4. gradle */
if (release && !existsSync(path.join(ANDROID, 'keystore.properties'))) {
  throw new Error(
    'release 构建缺少 app/android/keystore.properties。\n' +
      '  参考 app/android/keystore.properties.example 配置签名密钥。',
  )
}
const gradle = findGradle()
const task = release ? 'assembleRelease' : 'assembleDebug'
execFileSync(`"${gradle}" ${task} --console=plain`, {
  cwd: ANDROID,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK },
})
const apkDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug')
const apks = existsSync(apkDir) ? readdirSync(apkDir).filter((f) => f.endsWith('.apk')) : []
if (!apks.length) throw new Error('gradle 跑完了但没找到 APK')
const apk = path.join(apkDir, apks.find((f) => f === `app-${release ? 'release' : 'debug'}.apk`) ?? apks[0])
log(`APK：${apk}（${(statSync(apk).size / 1024).toFixed(0)} KB）`)

if (release) {
  const apksigner = findBuildTool('apksigner.bat')
  if (!apksigner) throw new Error('找不到 apksigner：检查 Android SDK build-tools')
  log('验证 APK 签名')
  execFileSync(apksigner, ['verify', '--print-certs', apk], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, JAVA_HOME: JDK },
  })
}

let aab = null
if (buildAab) {
  execFileSync(`"${gradle}" bundleRelease --console=plain`, {
    cwd: ANDROID,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK },
  })
  aab = path.join(ANDROID, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab')
  if (!existsSync(aab)) throw new Error('gradle 跑完了但没找到 AAB')
  const jarsigner = path.join(JDK, 'bin', 'jarsigner.exe')
  log('验证 AAB 签名')
  execFileSync(jarsigner, ['-verify', aab], { stdio: 'pipe' })
  log('AAB 签名校验通过（jarsigner 的 JAR 一致性警告属正常）')
  log(`AAB：${aab}（${(statSync(aab).size / 1024).toFixed(0)} KB）`)
}

/* 4b. 自检：APK 里真的装进了刚构建出来的那份 dist 吗？
 *
 *  这一步是被一次真实的错装逼出来的：我用
 *      node build_apk.mjs | Select-String 'BUILD SUCCESS'
 *  过滤构建输出，而 PowerShell 的 Select-Object -First N 会**终止上游管道** ——
 *  构建完成了，脚本却在跑 adb install 之前被杀掉了。手机上于是装的是上一个包，
 *  而本机 dist 是新的。
 *
 *  最坑的地方是**它完全静默**：构建日志写着 BUILD SUCCESSFUL，
 *  adb install 从没执行，也没有报错。于是「改了没生效」会被误判成
 *  「改动写错了」「Gradle 没重新打包」「CSS 不生效」——
 *  实际去查 CSS 语法，方向完全错，本轮就为这个绕了十几分钟。
 *
 *  现在从 APK 里把 index.html 抠出来，看它引用的是不是当前 dist 的那个 js 文件名。
 *  对不上就直接抛错，不让一个装着旧代码的 APK 继续往下走。 */
const bundleName = readdirSync(path.join(WEB, 'dist', 'assets')).find((f) => f.endsWith('.js'))
const apkHtml = readApkEntry(apk, 'assets/index.html')
if (apkHtml && bundleName) {
  const inApk = (apkHtml.match(/assets\/index-[\w-]+\.js/) || [])[0]
  const want = `assets/${bundleName}`
  if (inApk !== want) {
    throw new Error(
      `APK 里的前端和本次构建不一致：APK=${inApk}，本次构建=${want}\n` +
        '  gradle 复用了旧的打包结果。跑一次 gradle clean 再重试。',
    )
  }
  log(`自检通过：APK 内是本次构建的 ${bundleName}`)
}

/* 5. 装到手机 */
if (!install) {
  log(release ? 'release 包不自动安装（需要时显式加 --install）' : '--no-install，跳过安装')
  process.exit(0)
}
if (!existsSync(ADB)) {
  log(`没找到 adb（${ADB}），把 APK 拷到手机上点开装`)
  process.exit(0)
}
const rows = execFileSync(ADB, ['devices'], { encoding: 'utf8' })
  .split('\n')
  .slice(1)
  .map((l) => l.trim())
  .filter(Boolean)
const ready = rows.filter((d) => d.endsWith('\tdevice'))
if (!ready.length) {
  log('没有已授权的设备')
  log(`  当前：${rows.join(' / ') || '(没看到设备)'}`)
  log('  → 手机解锁，弹出「允许 USB 调试吗？」勾「一律允许」再点确定')
  process.exit(2)
}
for (const r of ready) {
  const serial = r.split(/\s+/)[0]
  log(`安装到 ${serial}`)
  execFileSync(ADB, ['-s', serial, 'install', '-r', '-d', apk], { stdio: 'inherit' })
}
log(`装好了：桌面上的图标叫「极简单词」，包名 ${release ? 'com.wordbank.app' : 'com.wordbank.app.debug'}`)
log('★ 换手机/重装前记得在「更多 → 导出」备份 —— 学习进度存在手机本地，重装会没')