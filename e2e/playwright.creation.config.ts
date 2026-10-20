import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// 此用例自己管理临时服务和重启；不能借用普通 dev 回归的共享后端。
const root = join(import.meta.dirname, '..')
const development = process.env.PLEIN_FLOW_DEV === '1'
const backendPort = Number(process.env.PLEIN_FLOW_PORT ?? 8793)
const webPort = Number(process.env.PLEIN_E2E_WEB_PORT ?? 8794)
if (development) {
  process.env.PLEIN_FLOW_PORT = String(backendPort)
  process.env.PLEIN_FLOW_BASE_URL = `http://127.0.0.1:${webPort}`
}

export default defineConfig({
  testDir: '.',
  testMatch: 'creation-end-to-end.spec.ts',
  outputDir: '../test-results',
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: development
    ? {
        command: `../../node_modules/.bin/vp dev --mode e2e --host 127.0.0.1 --port ${webPort} --strictPort`,
        cwd: join(root, 'apps/web'),
        url: `http://127.0.0.1:${webPort}`,
        reuseExistingServer: false,
        env: { PLEIN_SERVER: `http://127.0.0.1:${backendPort}` },
      }
    : undefined,
})
