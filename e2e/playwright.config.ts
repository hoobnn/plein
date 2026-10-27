import { defineConfig, devices } from '@playwright/test'
import { cpus } from 'node:os'
import { PLACEHOLDER_BASE_URL } from './worker-server'
import { outputPath } from './run-scope'

/**
 * 界面冒烟（L3 的界面部分）：真服务 + mock 平台 + e2e 构建的前端。
 *
 * 并行模型：每个 worker 起一份自己的后端（独立端口 + 独立数据目录），文件之间并行、
 * 文件内部串行。baseURL 由 worker 作用域的 fixture 覆盖，见 `e2e/fixtures.ts`。
 * 数据目录由各 worker 的服务监护进程独占创建、结束后回收，不留状态。
 *
 * 默认由系统分配端口；`PLEIN_E2E_BASE_PORT` 可指定基准，每个 worker 占 64 个顺延端口。
 */

/** 并行度：默认取核数的一半，浏览器本身吃 CPU，留一半给服务和工具链 */
const defaultWorkers = Math.max(1, Math.floor(cpus().length / 2))
const workers = Number(process.env.PLEIN_E2E_WORKERS ?? defaultWorkers)

export default defineConfig({
  testDir: '.',
  outputDir: outputPath('main'),
  // 文件之间并行，文件内部保持串行（一条用例走完整条流水线，状态前后相依）
  workers,
  fullyParallel: false,
  // CI 重试通过的用例仍标成 flaky，稳定失败仍然算失败；本地验收不重试。
  retries: process.env.CI ? 1 : 0,
  // 默认超时收紧到一分钟：界面冒烟里没有一条该跑更久；
  // 确实需要长时间的用例在自己的文件里调大
  timeout: 60_000,
  // 断言超时保持 15s：有些用例等的是服务端 10s 一次的轮询，
  // 断言超时再短就比轮询周期还短，稳定失败
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    // baseURL 由 worker fixture 覆盖，这里给一个占位值，保证单跑一条用例时也有地址
    baseURL: PLACEHOLDER_BASE_URL,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
