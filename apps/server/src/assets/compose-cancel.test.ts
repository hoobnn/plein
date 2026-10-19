import * as childProcess from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { ComposeSpec } from '@plein/plugin-sdk'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { tempDir } from '../testing'
import { composeVideo } from './compose'
import { ffmpegBin, hasFfmpeg } from './media'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const available = await hasFfmpeg()
afterEach(() => vi.clearAllMocks())

describe.skipIf(!available)('真实合成进程取消', () => {
  for (const paused of [false, true])
    it.skipIf(paused && process.platform === 'win32')(
      `${paused ? '进程暂停时升级终止，' : ''}取消 Promise 结束前进程已经退出，随后可重新合成`,
      async () => {
        const dir = tempDir('plein-compose-cancel-')
        const image = join(dir, 'image.png')
        childProcess.execFileSync(ffmpegBin(), [
          '-hide_banner',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=64x64',
          '-frames:v',
          '1',
          image,
        ])
        const spawn = vi.mocked(childProcess.spawn)
        const ctrl = new AbortController()
        let proc: ChildProcess | undefined
        let closed: Promise<void> | undefined
        let exited = false
        const spec: ComposeSpec = {
          width: 640,
          height: 360,
          fps: 30,
          clips: [
            { asset: { assetId: 'a'.repeat(64), kind: 'image' }, in: 0, out: 120, volume: 0 },
          ],
          audio: [],
        }
        const files = { clips: [image], audio: [] }
        const infos = { clips: [{ hasVideo: true, hasAudio: false }] }
        try {
          await expect(
            composeVideo(spec, files, infos, dir, {
              signal: ctrl.signal,
              onProgress: () => {
                if (ctrl.signal.aborted) return
                proc = spawn.mock.results.at(-1)!.value as ChildProcess
                closed = new Promise((resolve) =>
                  proc!.once('close', () => {
                    exited = true
                    resolve()
                  }),
                )
                if (paused) process.kill(proc!.pid!, 'SIGSTOP')
                ctrl.abort()
              },
            }),
          ).rejects.toMatchObject({ name: 'AbortError' })
          expect(proc?.pid).toBeGreaterThan(0)
          expect(exited).toBe(true)
          expect(proc!.exitCode !== null || proc!.signalCode !== null).toBe(true)
          if (paused) expect(proc!.signalCode).toBe('SIGKILL')
        } finally {
          ctrl.abort()
          if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
          await closed
        }
        const retry = await composeVideo(
          { ...spec, clips: [{ ...spec.clips[0]!, out: 0.3 }] },
          files,
          infos,
          dir,
          { signal: new AbortController().signal },
        )
        expect(retry.duration).toBeCloseTo(0.3)
      },
      30_000,
    )

  it('已取消的任务不启动合成进程', async () => {
    const spawn = vi.mocked(childProcess.spawn)
    const ctrl = new AbortController()
    ctrl.abort()
    const spec: ComposeSpec = {
      width: 64,
      height: 64,
      fps: 30,
      clips: [{ asset: { assetId: 'a'.repeat(64), kind: 'image' }, in: 0, out: 1, volume: 0 }],
      audio: [],
    }
    await expect(
      composeVideo(
        spec,
        { clips: ['/missing.png'], audio: [] },
        { clips: [{ hasVideo: true, hasAudio: false }] },
        tempDir(),
        { signal: ctrl.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('普通合成失败仍报告原始文件错误，不被当成取消', async () => {
    const dir = tempDir()
    const spec: ComposeSpec = {
      width: 64,
      height: 64,
      fps: 30,
      clips: [{ asset: { assetId: 'a'.repeat(64), kind: 'image' }, in: 0, out: 1, volume: 0 }],
      audio: [],
    }
    await expect(
      composeVideo(
        spec,
        { clips: [join(dir, 'missing.png')], audio: [] },
        { clips: [{ hasVideo: true, hasAudio: false }] },
        dir,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/ffmpeg 合成失败[\s\S]*missing\.png/)
  })
})
