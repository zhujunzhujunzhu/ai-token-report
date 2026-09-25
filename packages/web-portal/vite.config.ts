import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 开发服务器要转发的后端地址。
 *
 * `bun run dev:portal` 起的只是 Vite（前端资源），**它不实现
 * `/api/v1/stats/*`**。没有代理时这些请求会命中 Vite 的 SPA fallback，
 * 返回 `index.html`（HTTP 200 但 `Content-Type: text/html`），
 * 前端 `JSON.parse` 失败，页面显示「服务端返回了非 JSON 响应」——
 * 报错看起来像后端坏了，实际是后端压根没被访问到。
 *
 * 后端由 `bun run server` 提供（默认 127.0.0.1:8787，端口被占用会自动 +1）。
 * 端口被占用时用 `DSH_PORTAL_API` 指定实际地址即可，例如：
 *   $env:DSH_PORTAL_API='http://127.0.0.1:8788'; bun run dev:portal
 */
const portalApiTarget = process.env.DSH_PORTAL_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 与 web-local（5199）区分开，两者可同时起
    port: 5198,
    open: false,
    proxy: {
      // 转发部门接口，让开发服务器与「服务端托管构建产物」的形态行为一致。
      // ⚠️ 生产形态下本页由 `bun run server` 直接托管，同源，不需要代理。
      '/api': {
        target: portalApiTarget,
        changeOrigin: false,
      },
    },
  },
})
