/**
 * worker 作用域的服务实例：每个 worker 一个独立后端进程、端口和数据目录。
 *
 * 并行跑的关键约束是隔离：worker 之间不能共用端口或数据目录，否则用例会互相
 * 看到对方的画布、任务和资产。Playwright 的 `webServer` 是整轮一次，没法按 worker
 * 分开，所以在 worker 作用域的 fixture 里自己起服务，默认由系统分配端口，
 * 显式指定基准时按 worker 拆开顺延区间，数据目录也各自独占。
 *
 * 服务的启动与回收复用 `server-lifecycle.ts` 的监护逻辑（同一套目录所有权规则），
 * 所以单 worker 与多 worker 的生命周期语义一致：先停后端再删目录。
 */
import { fork, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/**
 * baseURL 的占位值：真正的地址由 worker 作用域的 fixture 按 worker 填。
 * 配置里写了别的地址（开发态的 dev server）时，说明后端由配置自己的 webServer 管，
 * fixture 就不再另起一份。
 */
export const PLACEHOLDER_BASE_URL = 'http://127.0.0.1:0'

/** worker 专属后端：端口、数据目录和健康检查地址 */
export interface WorkerServer {
  port: number
  dataDir: string
  baseURL: string
}

/** 轮询直到后端健康检查通过；超时说明这一轮 worker 的服务没能起来 */
async function waitHealthy(url: string, timeoutMs: number, child: ChildProcess) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`E2E 后端进程提前退出（code=${child.exitCode}）`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
      lastError = new Error(`健康检查返回 ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`E2E 后端在 ${timeoutMs}ms 内未就绪：${String(lastError)}`)
}

function waitListening(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error, url?: string) => {
      clearTimeout(timer)
      child.off('message', message)
      child.off('exit', exited)
      child.off('error', failed)
      if (error) reject(error)
      else resolve(url!)
    }
    const message = (value: unknown) => {
      const ready = value as { type?: string; url?: string } | null
      if (ready?.type === 'listening' && typeof ready.url === 'string') done(undefined, ready.url)
    }
    const exited = (code: number | null) => done(new Error(`E2E 后端进程提前退出（code=${code}）`))
    const failed = (error: Error) => done(error)
    const timer = setTimeout(() => done(new Error('E2E 后端未宣告监听成功')), timeoutMs)
    child.on('message', message)
    child.once('exit', exited)
    child.once('error', failed)
  })
}

/**
 * 起一个 worker 专属后端。返回句柄，调用方负责 `stop()`。
 * 数据目录由监护进程独占创建，进程组停止后再删除。
 */
export async function startWorkerServer(options: {
  port: number
  dataDir: string
  serverCommand: string
  webDist: string
  extraEnv?: Record<string, string>
  timeoutMs?: number
}): Promise<{ server: WorkerServer; stop: () => Promise<void> }> {
  const { port, dataDir, serverCommand, webDist, extraEnv = {} } = options
  const timeoutMs = options.timeoutMs ?? 60_000
  // 只准备父目录。已有叶目录属于其他服务，必须由监护进程拒绝认领。
  await mkdir(dirname(dataDir), { recursive: true })
  const child = fork(fileURLToPath(import.meta.url), ['--serve'], {
    // 监护进程与后端各自成组：监护进程负责把后端整组停干净
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      PLEIN_E2E_SERVER_COMMAND: serverCommand,
      // 监护进程独占创建这个目录，停止后由它回收
      PLEIN_E2E_OWN_DATA: dataDir,
      PLEIN_E2E_RUNNER_PID: String(process.pid),
      PLEIN_E2E_REPORT_READY: '1',
      PLEIN_PORT: String(port),
      PLEIN_DATA_DIR: dataDir,
      PLEIN_WEB_DIST: webDist,
      PLEIN_MOCK_PROVIDER: '1',
      PLEIN_AGENT: '0',
      ...extraEnv,
    },
  })
  let baseURL: string
  try {
    baseURL = await waitListening(child, timeoutMs)
    if (port !== 0 && Number(new URL(baseURL).port) !== port)
      throw new Error('E2E 后端监听端口与分配端口不一致')
    await waitHealthy(`${baseURL}/api/health`, timeoutMs, child)
  } catch (error) {
    await stopChild(child)
    throw error
  }
  return {
    server: { port: Number(new URL(baseURL).port), dataDir, baseURL },
    stop: async () => {
      await stopChild(child)
      // 只有监护进程知道是否已取得所有权、后端整组是否退出；不能在这里盲删。
    },
  }
}

/** 停掉监护进程：它会先停后端再回收数据目录 */
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    child.send?.({ stop: 'SIGTERM' })
  } catch {
    // IPC 已经断了，走信号兜底
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出
    }
  }, 15_000)
  timer.unref()
  await exited
  clearTimeout(timer)
}

/** 端口是否可用：并行时避免撞上别的进程已经占住的端口 */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/** 找一个可用端口：优先用期望端口，被占用时往后顺延 */
export async function pickPort(base: number, offset: number, span: number): Promise<number> {
  for (let i = 0; i < span; i++) {
    const candidate = base + offset + i
    if (candidate > 65535) break
    if (await portFree(candidate)) return candidate
  }
  throw new Error(`E2E 端口 ${base + offset} 起 ${span} 个都被占用`)
}

/**
 * 以监护模式运行：独占创建数据目录、起后端、等它退出，最后回收目录。
 * 复用 `server-lifecycle.ts` 的监护实现，保证并行与单 worker 的回收语义一致。
 */
async function serve() {
  // 监护实现在另一个文件里。Node 跑 TypeScript 时动态引入要带 .ts 后缀；
  // 用变量拼路径，避开类型检查对 .ts 扩展的限制（运行时才解析）。
  const modulePath = './server-lifecycle.ts'
  const { ownServer } = (await import(modulePath)) as { ownServer: () => Promise<number> }
  return ownServer()
}

if (process.argv[2] === '--serve') {
  try {
    process.exitCode = await serve()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    if (process.connected) process.disconnect?.()
  }
}
