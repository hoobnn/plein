import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

/** 开发时接口、MCP 与同步都转发到本地服务端（pnpm dev:server） */
const server = process.env.PLEIN_SERVER ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  // JASSUB 用 new URL(..., import.meta.url) 找自己的 worker 和 wasm，预构建会打乱相对路径
  optimizeDeps: { exclude: ['jassub'] },
  worker: { format: 'es' },
  build: { manifest: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: server },
      '/mcp': { target: server },
      '/sync': { target: server, ws: true },
    },
  },
})
