/** 原生桥接 —— 装成 APK 时才有的一层能力。
 *
 *  浏览器里 `window.WBNative` 不存在，所有调用都优雅降级到 Web API；
 *  装了 APK 时它由 MainActivity 用 `addJavascriptInterface` 注入，
 *  于是导出可以直接调起系统分享面板（微信 / QQ / 保存 / 邮件都在里面），
 *  而不是把文件丢进一个用户找不到的目录。
 *
 *  注意：桥接是**同步返回字符串**的（Android 的 @JavascriptInterface 只支持
 *  基本类型返回值），所以这里统一返回 Promise，由桥接把结果字符串化。
 */

import { ref } from 'vue'

interface NativeBridgeApi {
  /** 弹系统分享面板分享一个文件。返回 'shared' | 'canceled' | 'failed' */
  shareFile: (name: string, content: string, label: string) => Promise<string>
  /** 分享纯文本 */
  shareText: (title: string, text: string) => Promise<boolean>
  /** 复制到剪贴板 */
  copyText: (text: string) => Promise<boolean>
  /** 打开系统分享面板发一个文件（内部用 intent） */
  toast: (msg: string) => void
}

declare global {
  interface Window {
    WBNative?: NativeBridgeApi
  }
}

/** 有原生桥接说明装成了 APK */
export const nativeBridge: NativeBridgeApi | undefined =
  typeof window === 'undefined' ? undefined : window.WBNative

/**
 * 「从微信/QQ/文件管理器里点开一个 JSON 文件」的待处理内容。
 *
 *  放成模块级、而不是塞在某个页面的 onMounted 里，是因为**只有那个页面挂着
 *  才收得到事件**，而用户点开文件时不一定在那个页面 ——
 *  停在首页的话事件直接扔进虚空：系统读到了文件、事件也派发了，
 *  网页侧却没有页面在听。表现是「点了那个文件，什么都没发生」，连日志都没有。
 *  这是把「事件的接收方」和「事件的处理方」绑在一起的后果。
 *
 *  现在的约定：App.vue（永远挂着）接事件写进这里，处理方只管 watch 它。
 */
export interface IncomingFile {
  name: string
  text: string
}
export const incomingFile = ref<IncomingFile | null>(null)