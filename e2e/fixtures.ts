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
import { basePort, dataPath, portSpan } from './run-scope'
import type { Catalog } from '../packages/protocol/src/plugins'
import {
  pickPort,
  startWorkerServer,
  PLACEHOLDER_BASE_URL,
  type WorkerServer,
} from './worker-server'

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

/**
 * 配置里写了真地址（开发态回归的 dev server）时，后端由配置自己的 webServer 管，
 * fixture 不再另起一份，baseURL 也用配置给的那个。
 */
function configuredBaseURL(baseURL: string | undefined): string | undefined {
  return baseURL && baseURL !== PLACEHOLDER_BASE_URL ? baseURL : undefined
}

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

/** 重启的 worker 也使用新目录，不接管可能仍在退出的旧服务。 */
export const workerDataDir =
  process.env.PLEIN_E2E_EXTERNAL_DATA ??
  dataPath(`w${process.env.TEST_WORKER_INDEX ?? workerIndex}`)

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
  /** worker 启动时各平台的配置：每个文件跑完恢复回去 */
  providerSnapshot: ProviderSnapshot[]
}

/** 用例级的 fixture */
export interface E2EFixtures {
  /**
   * 文件跑完后把平台配置恢复成 worker 启动时的样子。
   * 有用例会改 mock 平台的开关和参数（模拟报错、排队、鉴权失败），
   * 改完不复原的话，同一 worker 里后面��文件会带着这些改动跑，行为就不确定了。
   */
  resetProviders: void
}

/** worker 启动时某个平台的配置 */
interface ProviderSnapshot {
  id: string
  enabled: boolean
  settings: Record<string, unknown>
  /** 启动时已填的密钥：只有它们保留，其余一律清掉 */
  keptSecrets: string[]
}

/** 平台配置视图：密钥只回显是否已填 */
interface ProviderConfigView {
  enabled: boolean
  settings: Record<string, unknown>
  secrets: Record<string, boolean>
}

/**
 * 记下 worker 启动时各平台的配置。
 *
 * 恢复成启动时的样子，而不是写死一份「默认值」：没配置过的平台存的是空设置，
 * 写死默认值会把「未设置」变成「显式填了 0」，界面显示的选项就跟着变了
 * （排队枚举会从「默认」变成「0」），后面的用例会莫名其妙地失败。
 */
async function snapshotProviders(baseURL: string): Promise<ProviderSnapshot[]> {
  const response = await fetch(`${baseURL}/api/catalog`)
  // 密码模式下目录要登录才给，这时还没有会话；没有初始状态也就无从恢复
  if (!response.ok) return []
  const catalog = (await response.json()) as Catalog
  if (!Array.isArray(catalog.providers)) return []
  const snapshots: ProviderSnapshot[] = []
  for (const provider of catalog.providers) {
    const response = await fetch(`${baseURL}/api/providers/${provider.id}/config`)
    if (!response.ok) continue
    const view = (await response.json()) as ProviderConfigView
    snapshots.push({
      id: provider.id,
      enabled: view.enabled,
      settings: view.settings,
      keptSecrets: Object.entries(view.secrets)
        .filter(([, has]) => has)
        .map(([name]) => name),
    })
  }
  return snapshots
}

export const test = base.extend<E2EFixtures, E2EWorkerFixtures>({
  // 默认借 worker 的后端；标了 ownService 的用例自己起服务
  ownService: [false, { scope: 'worker', option: true }],
  resetProviders: [
    async ({ request, providerSnapshot }, use) => {
      await use()
      // 文件跑完（不论成败）都把平台配置恢复成 worker 启动时的样子，
      // 别把改动留给后面的文件
      for (const snapshot of providerSnapshot) {
        const url = `/api/providers/${snapshot.id}/config`
        const current = await request
          .get(url)
          .then((response) => response.json() as Promise<ProviderConfigView>)
          .catch(() => null)
        // 用例新填的密钥清掉：值取不回来，但 e2e 里的密钥只是占位，不必保留
        const secrets = Object.fromEntries(
          Object.keys(current?.secrets ?? {})
            .filter((name) => !snapshot.keptSecrets.includes(name))
            .map((name) => [name, null]),
        )
        const restored = await request
          .put(url, {
            data: { enabled: snapshot.enabled, settings: snapshot.settings, secrets },
          })
          .catch(() => null)
        // 平台的设置有必填项时整体恢复会被拒；至少把开关恢复回去
        if (!restored?.ok())
          await request.put(url, { data: { enabled: snapshot.enabled } }).catch(() => undefined)
      }
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
      // 配置自己给了地址（开发态 dev server）：后端由配置的 webServer 起
      const external = configuredBaseURL(workerInfo.project.use.baseURL)
      if (external) {
        await use({ port: 0, dataDir: workerDataDir, baseURL: external })
        return
      }
      // 顺延区间互不重叠，不能探测到相邻 worker 尚未绑定的首选端口。
      const port = process.env.PLEIN_E2E_BASE_PORT
        ? await pickPort(basePort, workerInfo.parallelIndex * portSpan, portSpan)
        : 0
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
      try {
        await use(handle.server)
      } finally {
        await handle.stop()
      }
    },
    { scope: 'worker' },
  ],
  // 平台配置的初始状态：worker 起来时记一次，后面每个文件跑完都恢复回去
  providerSnapshot: [
    async ({ workerServer }, use) => {
      // 自管服务的用例没有 worker 后端，也就无从恢复
      if (workerServer.port === 0) {
        await use([])
        return
      }
      await use(await snapshotProviders(workerServer.baseURL))
    },
    { scope: 'worker' },
  ],
  // baseURL 跟着 worker 走：页面导航和 request fixture 都用它
  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL)
  },
})
