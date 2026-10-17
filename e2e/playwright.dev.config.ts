import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

/** 开发态回归：保留 React StrictMode 的 effect 重放，后端与数据仍完全隔离。 */
const backend = base.webServer
if (!backend || Array.isArray(backend)) throw new Error('开发回归需要单个隔离后端')
const backendPort = Number(process.env.PLEIN_E2E_PORT ?? 8790)
const webPort = Number(process.env.PLEIN_E2E_WEB_PORT ?? 8792)
const root = join(import.meta.dirname, '..')

export default defineConfig({
  ...base,
  testMatch: ['library-navigation.spec.ts', 'viewer-media.spec.ts', 'media-pagination.spec.ts'],
  use: { ...base.use, baseURL: `http://127.0.0.1:${webPort}` },
  webServer: [
    { ...backend, cwd: root },
    {
      // mode=e2e 只打开测试入口；仍由 dev server 加载开发版 React。
      command: `pnpm --filter @plein/web exec vp dev --mode e2e --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: root,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      env: { PLEIN_SERVER: `http://127.0.0.1:${backendPort}` },
    },
  ],
})
