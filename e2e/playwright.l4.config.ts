import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.PLEIN_L4_PORT ?? 8796)
process.env.PLEIN_L4_PORT = String(PORT)

/**
 * L4 真实样例（发版门禁，见 docs/plan/acceptance-0.1.0.md）：真实平台、真实计费。
 * 不进 `pnpm e2e` 和 CI；用 `pnpm e2e:real` 手动跑，服务端由用例自己起停（中途要杀掉重启）。
 * 必须给 PLEIN_L4_DATA：一个已在设置里配好、启用了平台的数据目录，用例不会替你选平台。
 */
export default defineConfig({
  testDir: 'real',
  outputDir: '../test-results',
  testMatch: '**/*.l4.ts',
  workers: 1,
  timeout: 90 * 60_000,
  expect: { timeout: 30_000 },
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
