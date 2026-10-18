import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // 相对路径：GitHub Pages 这类部署在子目录的托管上，不加这行资源全 404。
  // PWA 也要它 —— manifest 的 start_url/scope 用相对路径，换域名不用改。
  base: './',
  server: {
    // 端口写死：5180，且 strictPort —— 端口被占就直接报错，不要自动跳到
    // 5181/5182，否则「昨天那个链接」和「今天的链接」不是一个东西，
    // 存的 localStorage、注册的 SW 都会对不上。
    // host 用 true（=0.0.0.0）：127.0.0.1:5180 照常能用，同时让手机能通过
    // 局域网 IP 连上来调试。注意局域网这条只是 HTTP，**装不了 PWA**（见 README）。
    host: true,
    port: 5180,
    strictPort: true,
    proxy: {
      // ← Node 后端还活着时用它做对照；新前端走 IndexedDB，不依赖它
      '/api': 'http://127.0.0.1:8777',
      // AI：桌面浏览器直接打第三方 API 会被 CORS 拦（对方不给 ACAO 头）。
      // 开发时把 AI 配置里的地址填 `/ai`，由这里同源转发 —— 代码不变，
      // 手机上则由原生桥发请求（见 src/ai/transport.ts）。
      '/ai': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/ai/, ''),
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
  },
})
