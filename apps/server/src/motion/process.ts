import { spawn } from 'node:child_process'

export class MotionError extends Error {
  readonly retryable = false
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MotionError'
  }
}

export function abortError(): Error {
  return new DOMException('Motion render cancelled', 'AbortError')
}

/** Minimal child environment: no provider credentials or parent Node flags. */
export function motionEnvironment(input: {
  ffmpeg: string
  ffprobe: string
  home: string
  temp: string
  chromePath?: string
}): NodeJS.ProcessEnv {
  return {
    PATH:
      process.platform === 'win32'
        ? process.env.SystemRoot
          ? `${process.env.SystemRoot}\\System32`
          : ''
        : '/usr/bin:/bin',
    ...(process.platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    HOME: input.home,
    USERPROFILE: input.home,
    TMPDIR: input.temp,
    TEMP: input.temp,
    TMP: input.temp,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HYPERFRAMES_FFMPEG_PATH: input.ffmpeg,
    HYPERFRAMES_FFPROBE_PATH: input.ffprobe,
    ...(input.chromePath ? { PRODUCER_HEADLESS_SHELL_PATH: input.chromePath } : {}),
    // Rendering must use the supplied local engine; never trigger browser downloads.
    PUPPETEER_SKIP_DOWNLOAD: 'true',
  }
}

export async function runTool(
  file: string,
  args: string[],
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) throw abortError()
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = '',
      timedOut = false,
      failure: Error | undefined
    let hard: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      child.kill('SIGTERM')
      hard ??= setTimeout(() => child.kill('SIGKILL'), 2_000)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs ?? 30_000)
    options.signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-2_000_000)
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-32_000)
    })
    child.on('error', (error) => {
      failure = error
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (hard) clearTimeout(hard)
      options.signal?.removeEventListener('abort', stop)
      if (options.signal?.aborted) reject(abortError())
      else if (failure) reject(new MotionError('motion_runtime_unavailable', failure.message))
      else if (timedOut) reject(new MotionError('motion_probe_timeout', `${file} timed out`))
      else if (code !== 0)
        reject(new MotionError('motion_probe_failed', stderr || `${file} exited ${code}`))
      else resolve({ stdout, stderr })
    })
  })
}
