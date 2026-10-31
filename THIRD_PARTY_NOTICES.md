# 第三方组件与许可

本项目代码以 **LGPL-3.0-only** 发布。以下组件/参考实现按各自许可证使用。
完整许可证文本在 [`LICENSES/`](LICENSES/) 与根目录 [`LICENSE`](LICENSE)。

## 运行时组件

| 组件 | 用途 | 许可证 | 版权 / 链接 |
|---|---|---|---|
| Vue 3 / Vue Router | 前端框架与路由 | MIT | Copyright (c) 2013-present, Yuxi (Evan) You · https://github.com/vuejs/core |
| Vant | 移动端组件库 | MIT | Copyright (c) 2016-present, Youzan · https://github.com/youzan/vant |
| Dexie.js | IndexedDB 封装 | Apache-2.0 | Copyright (c) Dexie.js contributors · https://github.com/dexie/Dexie.js |
| AndroidX WebKit / Core | WebView 资源加载、FileProvider | Apache-2.0 | Copyright The Android Open Source Project · https://developer.android.com/jetpack/androidx |
| OkHttp | 原生 HTTP / WebSocket | Apache-2.0 | Copyright 2019 Square, Inc. · https://github.com/square/okhttp |
| Gradle Wrapper | 构建脚本 | Apache-2.0 | Copyright Gradle Inc. · https://github.com/gradle/gradle |

Apache-2.0 全文见 [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)；
MIT 全文见 [`LICENSES/MIT.txt`](LICENSES/MIT.txt)。

## Edge TTS 移植（重要）

`app/android/app/src/main/java/com/wordbank/app/EdgeTts.java` 中的
**v2 DRM 签名（CS64 + 变形 SHA-256）移植自 [edge-tts](https://github.com/rany2/edge-tts) 7.3.1**，
原项目除 `srt_composer.py` 外采用 **LGPL-3.0**。本项目的 Java 实现是对其
`drm.py` 的移植与改写，因此同样按 LGPL-3.0 提供。

- 原项目版权：Copyright (c) 2014-2023 Christopher Down；
  Copyright (c) 2025- rany <rany@riseup.net>
- 原许可证全文：[`LICENSES/edge-tts-LICENSE.txt`](LICENSES/edge-tts-LICENSE.txt)
- 本项目使用的 LGPL-3.0 全文：[`LICENSE`](LICENSE)
- LGPL-3.0 引用的 GPL-3.0 全文：[`COPYING.GPL-3.0`](COPYING.GPL-3.0)

为满足 LGPL 对修改与重链接的要求，本项目全部源码（包括上述 Java 移植、
WebView 前端与 Android 壳）都在本仓库公开，可按 README 的构建步骤重新打包。
如果你分发修改后的 APK，请继续遵守 LGPL-3.0，并保留本文件与许可证。

## 仅构建期使用

Vite、TypeScript、vue-tsc、@vitejs/plugin-vue、fake-indexeddb、sharp 等只在开发和
打包时使用，不进入 APK 运行时；它们各自按其上游许可证使用。

## 免责声明

本项目按「现状」提供，不附带任何明示或暗示担保。第三方服务（包括 Edge TTS、
AI 接口）的可用性、条款与数据处理由其提供方决定，本项目不作出承诺。
