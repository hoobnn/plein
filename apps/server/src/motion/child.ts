import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { abortError, MotionError } from './process'

export interface MotionProgress {
  stage: string
  percent: number
  message: string
}
export interface MotionChildOptions {
  signal?: AbortSignal
  progress?: (event: MotionProgress) => void
  nodePath?: string
  workerPath?: string
  env: NodeJS.ProcessEnv
}

/** Both a standalone worker module and a bundled server entry retain a valid sibling path. */
export function resolveMotionWorkerPath(baseUrl = import.meta.url): string {
  const candidates = ['./worker.mjs', './motion/worker.mjs']
  if (baseUrl.endsWith('.ts')) candidates.push('./worker.ts')
  for (const relative of candidates) {
    const candidate = fileURLToPath(new URL(relative, baseUrl))
    if (existsSync(candidate)) return candidate
  }
  throw new MotionError(
    'motion_runtime_unavailable',
    'Motion worker entry is missing; include dist/motion/worker.mjs in the application bundle',
  )
}

export async function runMotionWorker(
  request: { projectDir: string; outputPath: string; useGpu: boolean; chromePath?: string },
  options: MotionChildOptions,
): Promise<{ warnings: unknown[]; outcome?: string }> {
  if (options.signal?.aborted) throw abortError()
  const worker = options.workerPath ?? resolveMotionWorkerPath()
  if (!existsSync(worker))
    throw new MotionError('motion_runtime_unavailable', `Motion worker not found: ${worker}`)
  const args = worker.endsWith('.ts')
    ? ['--import', createRequire(import.meta.url).resolve('tsx'), worker]
    : [worker]
  return await new Promise((resolve, reject) => {
    const child = spawn(options.nodePath ?? process.execPath, args, {
      env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: request.projectDir,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let result: { warnings: unknown[]; outcome?: string } | undefined
    let failure: Error | undefined,
      logs = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        /* process group already closed */
      }
    }
    const cancel = () => {
      if (child.connected) child.send({ cancel: true })
      kill('SIGTERM')
      killTimer ??= setTimeout(() => kill('SIGKILL'), 5_000)
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    child.stdout!.on('data', (data: Buffer) => {
      logs = (logs + data.toString()).slice(-32_000)
    })
    child.stderr!.on('data', (data: Buffer) => {
      logs = (logs + data.toString()).slice(-32_000)
    })
    child.on('error', (error) => {
      failure = error
    })
    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return
      const message = raw as {
        type: string
        stage: string
        percent: number
        message: string
        warnings?: unknown[]
        outcome?: string
        code?: string
      }
      if (message.type === 'progress') {
        try {
          options.progress?.({
            stage: message.stage,
            percent: message.percent,
            message: message.message,
          })
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
          cancel()
        }
      }
      if (message.type === 'complete')
        result = { warnings: message.warnings ?? [], outcome: message.outcome }
      if (message.type === 'error')
        failure ??= new MotionError(message.code ?? 'motion_render_failed', message.message)
    })
    child.on('spawn', () => {
      if (options.signal?.aborted) cancel()
      else child.send(request)
    })
    // Resolve/reject only after close: the host may safely remove workDir afterwards.
    child.on('close', (code) => {
      // A crashed worker must not leave its Chrome/FFmpeg descendants alive.
      kill('SIGKILL')
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', cancel)
      if (options.signal?.aborted) reject(abortError())
      else if (failure) reject(failure)
      else if (code !== 0 || !result)
        reject(new MotionError('motion_render_failed', `Motion worker exited ${code}: ${logs}`))
      else resolve(result)
    })
  })
}
