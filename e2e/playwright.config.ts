import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * 界面冒烟（L3 的界面部分）：真服务 + mock 平台 + e2e 构建的前端。
 * 先 `pnpm e2e` 构建 apps/web/dist-e2e，再由这里起服务；数据目录每次新建，结束不留状态。
 */
const root = join(import.meta.dirname, '..')
const PORT = Number(process.env.PLEIN_E2E_PORT ?? 8790)
const dataDir = process.env.PLEIN_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'plein-e2e-'))
process.env.PLEIN_E2E_DATA = dataDir

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  // 一条用例走完整条流水线，状态前后相依，不并行
  workers: 1,
  fullyParallel: false,
  // CI 每次全量一千六百多条，偶发的时序抖动重试一次；稳定失败仍然算失败，重试通过的会标成 flaky
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // PLEIN_E2E_SERVER：换成别的服务端入口，例如桌面安装包用的打包产物
    // （node apps/desktop/stage/server/main.mjs）
    command:
      process.env.PLEIN_E2E_SERVER ?? 'apps/server/node_modules/.bin/tsx apps/server/src/main.ts',
    cwd: root,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PLEIN_PORT: String(PORT),
      PLEIN_DATA_DIR: dataDir,
      PLEIN_WEB_DIST:
        process.env.PLEIN_E2E_DIST ?? join(import.meta.dirname, '../apps/web/dist-e2e'),
      PLEIN_MOCK_PROVIDER: '1',
      PLEIN_AGENT: '0',
    },
  },
})
