/** 导出 / 导入的「文件落地」方式。
 *
 *  移动端最反直觉的地方：网页里的 `<a download>` 在手机上**不可靠** ——
 *  它可能什么都不发生，也可能塞进一个用户找不到的目录。于是用户的真实体验
 *  是「导出完还得去文件管理器大海捞针」，而背单词的备份却最需要随手就能发到
 *  微信/QQ 存进聊天记录。
 *
 *  所以按可信度依次尝试：
 *   1. 原生桥接（装了 APK 才有）—— 调起系统分享面板，微信/QQ/保存全在里面。
 *      这条最稳，也最像原生 app。
 *   2. Web Share API（navigator.canShare({files})）—— 浏览器与新 WebView 支持，
 *      同样能调起系统分享面板。
 *   3. `<a download>` —— 桌面浏览器的老办法，手机上只作为兜底。
 *
 *  导入同理：给一个**显眼的大按钮**（不是顶栏里的小字），并说明可以从
 *  微信/QQ 收到的文件里直接选 —— 用户不需要先存到某个文件夹。
 */
import { nativeBridge } from './bridge'

export interface ShareOutcome {
  /** 分享面板是否真的弹出来了 */
  shared: boolean
  /** 用户是不是完成了分享（canceled = 主动关掉了） */
  outcome: 'shared' | 'canceled' | 'downloaded' | 'failed'
  name?: string
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出一个 JSON 文件：能分享就分享，不能才下载。 */
export async function exportFile(
  data: unknown,
  filename: string,
  label: string,
): Promise<ShareOutcome> {
  const text = JSON.stringify(data, null, 2)
  const blob = new Blob([text], { type: 'application/json' })
  const file = new File([blob], filename, { type: 'application/json' })

  // ① 原生桥接（APK）
  if (nativeBridge) {
    try {
      const r = (await nativeBridge.shareFile(filename, text, label)) as ShareOutcome['outcome']
      return { shared: r !== 'failed', outcome: r, name: filename }
    } catch {
      /* 落到下面 */
    }
  }

  // ② Web Share API
  try {
    const nav = navigator as Navigator & {
      canShare?: (d: ShareData) => boolean
      share?: (d: ShareData) => Promise<void>
    }
    if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
      await nav.share({ files: [file], title: label })
      return { shared: true, outcome: 'shared', name: filename }
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      return { shared: true, outcome: 'canceled', name: filename }
    }
    /* 真失败才落到下载 */
  }

  // ③ 兜底：直接下载
  try {
    downloadBlob(blob, filename)
    return { shared: false, outcome: 'downloaded', name: filename }
  } catch {
    return { shared: false, outcome: 'failed', name: filename }
  }
}

/** 选一个 JSON 文件读进来（导入内容包 / 恢复备份）。
 *
 *  Android 的文件选择器从「最近」开始，而用户刚发到微信里的文件通常在
 *  「下载」或微信的 Download 目录 —— 所以 `accept` 要宽松一点，
 *  并且不要用 capture（它会强制打开相册，用户想选文件时会很困惑）。
 *
 *  ⚠ 装成 APK 时这一步依赖壳实现 `WebChromeClient.onShowFileChooser`：
 *  没有它，`<input type=file>` 的 click() 在 WebView 里**什么都不会发生** ——
 *  表现就是「点了导入备份，界面毫无反应」，而网页侧没有任何报错可查。 */
export function pickJsonFile(): Promise<{ name: string; json: unknown } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    // .vwbak 是旧版本导出用的后缀，仍然要能选回来
    input.accept = 'application/json,.json,.vwbak,text/plain'
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    input.onchange = () => {
      const f = input.files?.[0]
      document.body.removeChild(input)
      if (!f) return resolve(null)
      f.text()
        .then((t) => {
          try {
            resolve({ name: f.name, json: JSON.parse(t) })
          } catch (e) {
            reject(new Error(`「${f.name}」不是合法 JSON：${(e as Error).message}`))
          }
        })
        .catch(reject)
    }
    // 用户取消时不会触发 change，input 留在 DOM 里；下次调用会重复添加。
    // 这里不改也能用（resolve(null) 分支会清掉），但保留引用便于排错。
    input.click()
  })
}

/** 复制一段文本（复制给 AI 的模板、导入的错误详情） */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (nativeBridge) {
    try {
      return await nativeBridge.copyText(text)
    } catch {
      /* 落到下面 */
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到 execCommand */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 读剪贴板文本。
 *
 *  ★ 为什么必须先走原生：浏览器要求 clipboard-read 权限 + 瞬时用户手势，
 *    Android WebView 里 `navigator.clipboard.readText()` 基本必然 reject ——
 *    用户看到的就是「读不到剪贴板，请长按输入框粘贴」。原生没有这层限制。
 *  读不到时返回 null（和「剪贴板为空」区分开）；浏览器里返回空串表示确实为空。
 */
export async function readClipboard(): Promise<string | null> {
  if (nativeBridge?.readClipboard) {
    try {
      return nativeBridge.readClipboard()
    } catch {
      /* 落到下面 */
    }
  }
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText()
  } catch {
    /* 落到 null */
  }
  return null
}

/** 把一段文字直接发出去（不是文件）—— 例如「点词库图标装到主屏」的引导。
 *  装了 APK 时也走原生，否则用户根本没法把备份发给自己。 */
export async function shareText(title: string, text: string): Promise<boolean> {
  if (nativeBridge) {
    try {
      return await nativeBridge.shareText(title, text)
    } catch {
      /* 落到下面 */
    }
  }
  try {
    if (navigator.share) {
      await navigator.share({ title, text })
      return true
    }
  } catch {
    return false
  }
  return copyToClipboard(text)
}
