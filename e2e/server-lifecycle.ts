/**
 * Playwright 服务监护：只回收本轮独占创建的数据，先停后端再删目录。
 * owner 独立于 Playwright 的进程组；IPC 断开或调用方退出都会触发相同清理。
 * macOS/Linux 使用进程组管理。owner 被 SIGKILL 或机器崩溃时不保证回收。
 */
import { execFileSync, fork, spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

type StopSignal = 'SIGINT' | 'SIGTERM'
const GRACE_MS = 5000

function groupExists(pid: number) {
  try {
    process.kill(-pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // macOS 的受限执行环境可能对已消失的进程组返回 EPERM；不能把它直接当作退出。
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
  // 僵尸已关闭文件与 socket，kill(0) 却仍认为它存在，不能等到强杀超时。
  return execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' })
    .split('\n')
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/)
      return Number(group) === pid && !state?.startsWith('Z')
    })
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitForGroup(pid: number) {
  const deadline = Date.now() + GRACE_MS
  while (groupExists(pid)) {
    if (Date.now() >= deadline) return false
    await delay(25)
  }
  return true
}

async function stopGroup(pid: number, signal: StopSignal) {
  signalGroup(pid, signal)
  if (await waitForGroup(pid)) return
  signalGroup(pid, 'SIGKILL')
  if (!(await waitForGroup(pid))) throw new Error(`E2E 后端进程组 ${pid} 尚未退出，保留数据目录`)
}

/**
 * 以监护者身份运行：独占创建数据目录、起后端、等它退出，最后回收目录。
 * 同时作为独立进程（`--owner`）和 worker 作用域 fixture 内的子进程使用。
 */
export async function ownServer() {
  const stop = new AbortController()
  const requestStop = (signal: StopSignal) => stop.abort(signal)
  process.on('SIGINT', () => requestStop('SIGINT'))
  process.on('SIGTERM', () => requestStop('SIGTERM'))
  process.on('disconnect', () => requestStop('SIGTERM'))
  process.on('message', (message) => {
    const signal = (message as { stop?: unknown } | null)?.stop
    if (signal === 'SIGINT' || signal === 'SIGTERM') requestStop(signal)
  })
  const dataDir = process.env.PLEIN_DATA_DIR
  const ownedData = process.env.PLEIN_E2E_OWN_DATA
  const command = process.env.PLEIN_E2E_SERVER_COMMAND
  const runnerPid = Number(process.env.PLEIN_E2E_RUNNER_PID)
  // Node 默认处理 SIGTERM 时不运行 JS exit 清理，webServer 也可能仅成为孤儿而未被杀。
  const parentWatch = setInterval(() => {
    try {
      process.kill(runnerPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') requestStop('SIGTERM')
    }
  }, 100)
  parentWatch.unref()
  let created = false
  let safeToRemove = true
  try {
    if (!dataDir || !command || !Number.isSafeInteger(runnerPid) || runnerPid <= 0)
      throw new Error('E2E 服务缺少数据目录、启动命令或调用方进程')
    if (ownedData) {
      if (ownedData !== dataDir || !isAbsolute(ownedData))
        throw new Error('E2E 自动目录标记与数据目录不一致')
      // 独占创建失败绝不认领，尤其不能删除已存在的目录。
      await mkdir(dataDir, { mode: 0o700 })
      created = true
    }
    if (stop.signal.aborted) return 0
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: 'inherit',
      env: process.env,
    })
    const exited = new Promise<number>((resolve) => {
      child.once('error', (error) => {
        console.error(error)
        resolve(1)
      })
      child.once('exit', (code) => resolve(code ?? 1))
    })
    const interrupted = new Promise<number>((resolve) => {
      stop.signal.addEventListener('abort', () => resolve(0), { once: true })
    })
    const code = await Promise.race([exited, interrupted])
    if (child.pid) {
      safeToRemove = false
      await stopGroup(child.pid, (stop.signal.reason as StopSignal | undefined) ?? 'SIGTERM')
      await exited
      safeToRemove = true
    }
    return code
  } finally {
    clearInterval(parentWatch)
    if (created && safeToRemove)
      await rm(dataDir!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

function monitorOwner() {
  const owner = fork(fileURLToPath(import.meta.url), ['--owner'], {
    detached: true,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (owner.connected) owner.send({ stop: signal })
    })
  owner.once('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
  owner.once('exit', (code) => {
    process.exitCode = code ?? 1
  })
}

/**
 * 这个文件既能被当成入口跑（`node e2e/server-lifecycle.ts`），
 * 也能被别的模块 import 复用 `ownServer`。
 * 只有作为入口时才自动起监护，被 import 时只导出函数。
 */
const isEntry = process.argv[1] === fileURLToPath(import.meta.url)

if (process.platform === 'win32') {
  throw new Error('E2E 服务监护目前支持 macOS/Linux')
} else if (isEntry && process.argv[2] === '--owner') {
  try {
    process.exitCode = await ownServer()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    if (process.connected) process.disconnect?.()
  }
} else if (isEntry) {
  monitorOwner()
}
