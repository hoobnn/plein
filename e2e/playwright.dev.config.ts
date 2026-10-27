import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from './playwright.config'

/**
 * 开发态回归：保留 React StrictMode 的 effect 重放，后端与数据仍完全隔离。
 *
 * 开发态打的是 dev server，Vite 的代理目标在启动时就定死了，没法按 worker 分，
 * 所以这里自己起一份固定端口的后端；配置里的 baseURL 不是占位值，
 * fixture 就不会再另起后端，也不会改写页面访问的地址。
 */
const backendPort = Number(process.env.PLEIN_E2E_PORT ?? 8790)
const webPort = Number(process.env.PLEIN_E2E_WEB_PORT ?? 8792)
const root = join(import.meta.dirname, '..')
const dataDir = join(tmpdir(), `plein-e2e-dev-${randomUUID()}`)

export default defineConfig({
  ...base,
  // 与生产配置发现相同的普通用例，避免手工白名单遗漏新增或早期主流程。
  // 完整创作用例自行重启后端，开发态由 playwright.creation.config.ts 单独运行。
  testIgnore: ['**/creation-end-to-end.spec.ts'],
  // manifest、gzip 预算和哈希资源检查只适用于生产构建，保留在普通生产配置中。
  grepInvert: /@production/,
  use: { ...base.use, baseURL: `http://127.0.0.1:${webPort}` },
  webServer: [
    {
      command: 'node e2e/server-lifecycle.ts',
      cwd: root,
      url: `http://127.0.0.1:${backendPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      env: {
        PLEIN_E2E_SERVER_COMMAND:
          process.env.PLEIN_E2E_SERVER ??
          'apps/server/node_modules/.bin/tsx apps/server/src/main.ts',
        // 监护进程独占创建这个目录，结束后回收
        PLEIN_E2E_OWN_DATA: dataDir,
        PLEIN_E2E_RUNNER_PID: String(process.pid),
        PLEIN_PORT: String(backendPort),
        PLEIN_DATA_DIR: dataDir,
        PLEIN_WEB_DIST: process.env.PLEIN_E2E_DIST ?? join(root, 'apps/web/dist-e2e'),
        PLEIN_MOCK_PROVIDER: '1',
        PLEIN_AGENT: '0',
        // 取值推迟到起服务那一刻：密码登录的配置在配置文件里设好
        get PLEIN_AUTH() {
          return process.env.PLEIN_E2E_AUTH === '1' ? 'password' : 'none'
        },
      },
    },
    {
      // mode=e2e 只打开测试入口；仍由 dev server 加载开发版 React。
      command: `../../node_modules/.bin/vp dev --mode e2e --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: join(root, 'apps/web'),
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      env: { PLEIN_SERVER: `http://127.0.0.1:${backendPort}` },
    },
  ],
})
