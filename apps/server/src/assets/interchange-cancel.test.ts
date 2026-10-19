import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { expect, it, vi } from 'vite-plus/test'
import { bootServer, tempDir } from '../testing'
import { sequencePackage } from './interchange'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

it('停止消费 ZIP 时立即中止真实素材流并关闭文件句柄', async () => {
  const file = join(tempDir(), 'reference.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1280x720:r=24:d=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '0',
    file,
  ])
  expect(fs.statSync(file).size).toBeGreaterThan(128 * 1024)
  const { server } = await bootServer()
  const asset = await server.assets.ingest('local', fs.createReadStream(file), {
    mime: 'video/mp4',
    name: 'reference.mp4',
  })
  const { stream } = await sequencePackage(server.assets, 'local', {
    width: 1280,
    height: 720,
    fps: 24,
    clips: [{ asset: { assetId: asset.id, kind: 'video' }, in: 0, volume: 1 }],
    audio: [],
  })
  const mock = vi.mocked(fs.createReadStream)
  const index = mock.mock.calls.findIndex(([path]) => path === server.assets.originalPath(asset.id))
  expect(index).toBeGreaterThanOrEqual(0)
  const source = mock.mock.results[index]!.value as fs.ReadStream
  const sourceClosed = new Promise<void>((resolve) => source.once('close', resolve))
  stream.on('error', () => {})
  try {
    const closed = once(stream, 'close')
    stream.destroy()
    await closed
    expect(source.destroyed).toBe(true)
    await expect.poll(() => source.closed, { timeout: 1500 }).toBe(true)
  } finally {
    source.destroy()
    await sourceClosed
  }
  const retry = await sequencePackage(server.assets, 'local', {
    width: 1280,
    height: 720,
    fps: 24,
    clips: [{ asset: { assetId: asset.id, kind: 'video' }, in: 0, volume: 1 }],
    audio: [],
  })
  const archive = join(tempDir(), 'retry.zip')
  await pipeline(retry.stream, fs.createWriteStream(archive))
  expect(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' })).toContain(
    'No errors detected',
  )
}, 30_000)
