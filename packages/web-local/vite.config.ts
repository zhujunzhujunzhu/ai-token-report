import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 开发服务器要转发的后端地址。
 *
 * `bun run dev:local` 起的只是 Vite（前端资源），**它不实现 `/api/local/*`**。
 * 没有代理时这些请求会命中 Vite 的 SPA fallback，返回 `index.html`（HTTP 200
 * 但 `Content-Type: text/html`），前端 `JSON.parse` 失败，页面显示
 * 「服务端返回了非 JSON 响应（HTTP 200）」—— 报错看起来像后端坏了，
 * 实际是后端压根没被访问到。
 *
 * 后端由 `dsh-token --web` / `bun run web` 提供（只监听 127.0.0.1，默认 8787）。
 * 端口被占用时 CLI 会自动 +1，此时用 `DSH_LOCAL_API` 指定实际地址即可，
 * 例如：`$env:DSH_LOCAL_API='http://127.0.0.1:8788'; bun run dev:local`
 */
const localApiTarget = process.env.DSH_LOCAL_API ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5199,
    open: false,
    proxy: {
      // 转发本地接口，让开发服务器与 `--web` 内嵌服务的页面行为一致。
      '/api': {
        target: localApiTarget,
        changeOrigin: false,
      },
    },
  },
})