import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'

/** 测量脚本（bench/*.measure.ts）的配置：不进默认 `pnpm test`，按需单独运行 */
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['bench/**/*.measure.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
