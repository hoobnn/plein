import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

/** 开发时接口与同步都转发到本地服务端（pnpm dev:server） */
const server = process.env.PLEIN_SERVER ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  server: {
    port: 5173,
    proxy: {
      '/api': { target: server },
      '/sync': { target: server, ws: true },
    },
  },
})
