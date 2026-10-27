import { createRequire } from 'node:module'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, lazyPlugins } from 'vite-plus'

/** 开发时接口、MCP 与同步都转发到本地服务端（pnpm dev:server） */
const server = process.env.PLEIN_SERVER ?? 'http://127.0.0.1:8787'
// linkedom 的 CSSOM browser 入口只有全局变量；使用同一发布包的 CJS 命名导出。
const sdkRequire = createRequire(import.meta.resolve('@hyperframes/sdk'))
const cssomEntry = createRequire(sdkRequire.resolve('linkedom')).resolve('@acemir/cssom')

export default defineConfig({
  resolve: { alias: { '@acemir/cssom': cssomEntry } },
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  test: { setupFiles: ['./src/testing/setup.ts'] },
  // JASSUB 用 new URL(..., import.meta.url) 找自己的 worker 和 wasm，预构建会打乱相对路径
  optimizeDeps: {
    exclude: ['jassub'],
    // 被排除的 ESM 包仍需单独预构建其嵌套 CommonJS 依赖。
    include: ['jassub > throughput'],
  },
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
