/**
 * e2e 的并行基础设施：worker 作用域的服务与 baseURL。
 *
 * 整轮 e2e 有三百多个文件、上千条用例，串行跑一个多小时。文件之间其实互不相干，
 * 所以让每个 worker 带一份自己的后端（独立端口 + 独立数据目录）并行跑，文件内部仍然串行。
 *
 * 用 `baseURL` 覆盖而不是改配置里的 `use.baseURL`：Playwright 的 `baseURL` 可以在
 * fixture 里按 worker 覆盖，`page.goto('/')` 和 `request.get('/api/...')` 都会跟着走，
 * 用例代码不需要任何改动。
 */
import { test as base, expect } from '@playwright/test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pickPort, startWorkerServer, type WorkerServer } from './worker-server'

/**
 * 用例里的类型也从这里出：类型只依赖 Playwright 的定义，
 * 但和 `test` 放在一处，用例只需要认一个模块。
 */
export type {
  Browser,
  BrowserContext,
  Download,
  ElementHandle,
  FileChooser,
  Frame,
  JSHandle,
  Locator,
  Page,
  Request,
  Response,
  Route,
  TestInfo,
  WebSocket,
  WebSocketRoute,
  Worker,
} from '@playwright/test'
export { expect }

/** 端口基准：与 8790/8795 错开，避免和别的 agent 正在跑的 e2e 撞车 */
const BASE_PORT = Number(process.env.PLEIN_E2E_BASE_PORT ?? 8800)
/** 每个 worker 最多顺延的端口数 */
const PORT_SPAN = 64

/** 整轮共享的服务命令与前端产物路径 */
const serverCommand =
  process.env.PLEIN_E2E_SERVER ?? 'apps/server/node_modules/.bin/tsx apps/server/src/main.ts'
const webDist = process.env.PLEIN_E2E_DIST ?? join(import.meta.dirname, '../apps/web/dist-e2e')

/**
 * 当前 worker 的序号。模块加载时就能读到：Playwright 在加载用例文件之前就把
 * `TEST_PARALLEL_INDEX` 写进 worker 进程的环境变量。
 * 少数用例要直接读服务的数据目录（断言落盘结果），靠这个序号推导出目录路径，
 * 不必等 fixture 起来之后才知道。
 */
export const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? 0)

/** 当前 worker 的数据目录：worker 序号决定，各 worker 互不相干 */
export const workerDataDir = join(
  process.env.PLEIN_E2E_DATA_ROOT ?? tmpdir(),
  `plein-e2e-w${workerIndex}`,
)

/**
 * 让 `process.env.PLEIN_E2E_DATA` 指向当前 worker 的数据目录。
 * 有用例直接读服务的数据目录（插件落盘、导出产物、任务表），并行下必须跟着 worker 走。
 */
process.env.PLEIN_E2E_DATA = workerDataDir

/** worker 级的 fixture 与开关 */
export interface E2EWorkerFixtures {
  /** 当前 worker 的后端地址：页面与 request fixture 都用它 */
  workerServer: WorkerServer
  /**
   * 自己管服务（自带隔离服务和重启），不借 worker 的后端。
   * 自管服务的用例用 `test.use({ ownService: true })` 标出来。
   */
  ownService: boolean
}

/** 用例级的 fixture */
export interface E2EFixtures {
  /**
   * 文件跑完后把平台配置恢复默认。
   * 有用例会改 mock 平台的开关和参数（模拟报错、排队、鉴权失败），
   * 改完不复原的话，同一 worker 里后面��文件会带着这些改动跑，行为就不确定了。
   */
  resetProviders: void
}

/** mock 平台在 e2e 下的默认配置：启用、不延迟、不报错 */
const MOCK_DEFAULTS = { enabled: true, settings: { latencyMs: 0, queueMs: 0, failWith: 'none' } }

export const test = base.extend<E2EFixtures, E2EWorkerFixtures>({
  // 默认借 worker 的后端；标了 ownService 的用例自己起服务
  ownService: [false, { scope: 'worker', option: true }],
  resetProviders: [
    async ({ request, workerServer }, use) => {
      await use()
      // 文件跑完（不论成败）都把 mock 平台恢复默认，别把改动留给后面的文件
      await request
        .put('/api/providers/plein/mock/config', { data: MOCK_DEFAULTS })
        .catch(() => undefined)
      void workerServer
    },
    { scope: 'test', auto: true },
  ],
  workerServer: [
    async ({ ownService }, use, workerInfo) => {
      // 自管服务的用例不需要 worker 的后端
      if (ownService) {
        await use({ port: 0, dataDir: workerDataDir, baseURL: 'http://127.0.0.1:0' })
        return
      }
      // worker 序号在整轮里唯一，重启后复用同一个序号
      const port = await pickPort(BASE_PORT, workerInfo.parallelIndex, PORT_SPAN)
      const handle = await startWorkerServer({
        port,
        dataDir: workerDataDir,
        serverCommand,
        webDist,
        extraEnv: {
          PLEIN_E2E_WORKER: String(workerInfo.parallelIndex),
          ...(process.env.PLEIN_E2E_AUTH === '1' ? { PLEIN_AUTH: 'password' } : {}),
        },
      })
      await use(handle.server)
      await handle.stop()
    },
    { scope: 'worker' },
  ],
  // baseURL 跟着 worker 走：页面导航和 request fixture 都用它
  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL)
  },
})
