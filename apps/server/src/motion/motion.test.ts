import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { describe, expect, it } from 'vite-plus/test'
import { motionEnvironment, runTool } from './process'
import { probeMotionRuntime } from './probe'
import { runMotionWorker, resolveMotionWorkerPath } from './child'

const fixture = async (fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'plein-motion-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('motion runtime boundary', () => {
  it('resolves source and bundled worker entries and rejects a missing packaged entry', async () => {
    await fixture(async (dir) => {
      const base = pathToFileURL(join(dir, 'main.mjs')).href
      expect(() => resolveMotionWorkerPath(base)).toThrow('Motion worker entry is missing')
      await mkdir(join(dir, 'motion'))
      await writeFile(join(dir, 'motion', 'worker.mjs'), '')
      expect(resolveMotionWorkerPath(base)).toBe(join(dir, 'motion', 'worker.mjs'))
      await writeFile(join(dir, 'worker.ts'), '')
      await rm(join(dir, 'motion'), { recursive: true })
      expect(resolveMotionWorkerPath(pathToFileURL(join(dir, 'child.ts')).href)).toBe(
        join(dir, 'worker.ts'),
      )
      expect(() => resolveMotionWorkerPath(base)).toThrow('Motion worker entry is missing')
    })
  })

  it('passes explicit binary paths but no parent secrets or Node flags', () => {
    const env = motionEnvironment({
      ffmpeg: '/test/ffmpeg',
      ffprobe: '/test/ffprobe',
      home: '/isolated/home',
      temp: '/isolated/tmp',
      chromePath: '/test/chrome',
    })
    expect(env.HYPERFRAMES_FFMPEG_PATH).toBe('/test/ffmpeg')
    expect(env.HYPERFRAMES_FFPROBE_PATH).toBe('/test/ffprobe')
    expect(env.PRODUCER_HEADLESS_SHELL_PATH).toBe('/test/chrome')
    expect(env.HOME).toBe('/isolated/home')
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.HEYGEN_API_KEY).toBeUndefined()
    expect(Object.keys(env)).not.toContain('CODEX_HOME')
  })

  it('refuses PATH-based media binaries before starting work', async () => {
    await expect(
      probeMotionRuntime({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
    ).rejects.toMatchObject({ code: 'motion_runtime_unavailable', retryable: false })
  })

  it('a compiled encoder that cannot encode does not pass preflight', async () => {
    await fixture(async (dir) => {
      const binary = join(dir, 'ffmpeg')
      await writeFile(
        binary,
        '#!/bin/sh\ncase "$2" in -encoders) echo " V..... libx264 Fake encoder"; exit 0;; esac\ncase "$1" in -version) echo "fake 1"; exit 0;; esac\necho "encode failed" >&2\nexit 1\n',
        { mode: 0o755 },
      )
      await expect(probeMotionRuntime({ ffmpeg: binary, ffprobe: binary })).rejects.toMatchObject({
        code: 'motion_encoder_unavailable',
        retryable: false,
      })
    })
  })

  it('waits for tool close on cancellation', async () => {
    const controller = new AbortController()
    const promise = runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      signal: controller.signal,
    })
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('waits for isolated worker termination before rejecting cancelled work', async () => {
    await fixture(async (dir) => {
      const worker = join(dir, 'worker.mjs')
      await writeFile(worker, 'process.on("message",()=>{}); setInterval(()=>{},1000)')
      const controller = new AbortController()
      const promise = runMotionWorker(
        { projectDir: dir, outputPath: join(dir, 'output.mp4'), useGpu: false },
        {
          signal: controller.signal,
          workerPath: worker,
          env: motionEnvironment({
            ffmpeg: '/unused/ffmpeg',
            ffprobe: '/unused/ffprobe',
            home: dir,
            temp: dir,
          }),
        },
      )
      controller.abort()
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    })
  })

  it('terminates the worker and rejects safely if the host progress callback fails', async () => {
    await fixture(async (dir) => {
      const worker = join(dir, 'worker.mjs')
      await writeFile(
        worker,
        'process.on("message",()=>process.send({type:"progress",stage:"rendering",percent:1,message:"rendering"})); setInterval(()=>{},1000)',
      )
      await expect(
        runMotionWorker(
          { projectDir: dir, outputPath: join(dir, 'output.mp4'), useGpu: false },
          {
            workerPath: worker,
            env: {},
            progress: () => {
              throw new Error('host progress unavailable')
            },
          },
        ),
      ).rejects.toThrow('host progress unavailable')
    })
  })

  it('does not accept an exited worker without a complete IPC result', async () => {
    await fixture(async (dir) => {
      const worker = join(dir, 'worker.mjs')
      await writeFile(worker, 'process.on("message",()=>process.exit(0))')
      await expect(
        runMotionWorker(
          { projectDir: dir, outputPath: join(dir, 'output.mp4'), useGpu: false },
          { workerPath: worker, env: {} },
        ),
      ).rejects.toMatchObject({ code: 'motion_render_failed' })
    })
  })
})

it('VP9 alpha requires its own working bundled encoder, without H264 fallback', async () => {
  await fixture(async (dir) => {
    const binary = join(dir, 'ffmpeg')
    await writeFile(
      binary,
      '#!/bin/sh\ncase "$2" in -encoders) echo " V..... libx264 Fake encoder"; exit 0;; esac\ncase "$1" in -version) echo "fake 1"; exit 0;; esac\nexit 0\n',
      { mode: 0o755 },
    )
    await expect(
      probeMotionRuntime({ ffmpeg: binary, ffprobe: binary, output: 'transparent-webm' }),
    ).rejects.toMatchObject({
      code: 'motion_encoder_unavailable',
      retryable: false,
      message: expect.stringContaining('VP9 alpha'),
    })
    await writeFile(
      binary,
      '#!/bin/sh\ncase "$2" in -encoders) echo " V..... libvpx-vp9 Fake encoder"; exit 0;; esac\ncase "$1" in -version) echo "fake 1"; exit 0;; esac\nexit 0\n',
      { mode: 0o755 },
    )
    expect(
      await probeMotionRuntime({ ffmpeg: binary, ffprobe: binary, output: 'transparent-webm' }),
    ).toMatchObject({ encoder: 'libvpx-vp9', useGpu: false })
  })
})
