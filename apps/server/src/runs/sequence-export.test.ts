import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setParams } from '@plein/doc'
import sharp from 'sharp'
import { describe, expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request, until } from '../testing'
import { hasFfmpeg, probeMedia } from '../assets/media'

const available = await hasFfmpeg()
async function fixture() {
  const { server, dataDir } = await bootServer()
  const image = await sharp({
    create: { width: 96, height: 64, channels: 3, background: 'orange' },
  })
    .png()
    .toBuffer()
  const asset = await server.assets.ingest('local', Readable.from([image]), {
    mime: 'image/png',
    name: 'frame.png',
  })
  const { id: canvas, doc } = await createCanvas(server)
  const shots = (duration: number) => [
    { shotId: 'one', duration, imageAssetId: asset.id, dialogue: [] },
  ]
  const node = addNode(doc, 'plein/animatic', {
    params: {
      resolution: '720p',
      aspectRatio: '16:9',
      subtitles: false,
      loudnorm: false,
      shots: shots(0.3),
    },
  })
  const endpoint = `/api/canvases/${canvas}/nodes/${node}`
  const start = async () => {
    const response = await request(server, `${endpoint}/run`, { method: 'POST' })
    expect(response.status).toBe(202)
    return ((await response.json()) as { runId: string }).runId
  }
  const snapshot = () => {
    const el = doc.get(node)!
    return { results: el.results, adopted: el.adopted, deliveries: el.deliveries }
  }
  const first = await start()
  expect(await server.runs.wait(first)).toBe('succeeded')
  await until(() => !!doc.get(node)?.deliveries?.length)
  const previous = snapshot()
  return { server, dataDir, asset, canvas, doc, node, endpoint, shots, start, snapshot, previous }
}

describe.skipIf(!available)('序列成片导出 HTTP 恢复合同', () => {
  it.each(['corrupt', 'missing'] as const)(
    '%s 原始素材失败保留旧成片与交付，修复后可再次导出',
    async (mode) => {
      const f = await fixture()
      const file = f.server.assets.originalPath(f.asset.id)
      const original = readFileSync(file)
      setParams(f.doc, f.node, { shots: f.shots(0.5) })
      try {
        if (mode === 'missing') unlinkSync(file)
        else writeFileSync(file, 'damaged image')
        const failed = await f.start()
        expect(await f.server.runs.wait(failed)).toBe('failed')
        expect(f.server.runs.store.get(failed)?.error).toMatch(
          mode === 'missing' ? new RegExp(f.asset.id) : /unsupported image format/i,
        )
        expect(f.snapshot()).toEqual(f.previous)
        const result = f.previous.results!.find((r) => r.id === f.previous.adopted)!
        if (result.value.type !== 'video') throw new Error('Expected exported video')
        expect((await request(f.server, `/api/assets/${result.value.assetId}`)).status).toBe(200)
        expect(
          (await probeMedia(f.server.assets.originalPath(result.value.assetId!))).duration,
        ).toBeCloseTo(0.3, 1)
      } finally {
        writeFileSync(file, original)
      }
      const retry = await f.start()
      expect(await f.server.runs.wait(retry)).toBe('succeeded')
      await until(() => f.doc.get(f.node)?.deliveries?.length === 2)
      expect(f.snapshot().results).toHaveLength(2)
      expect(f.snapshot().results).toEqual(expect.arrayContaining(f.previous.results!))
      const latest = f.snapshot().results!.find((r) => r.id === f.snapshot().adopted)!
      if (latest.value.type !== 'video') throw new Error('Expected exported video')
      expect(
        (await probeMedia(f.server.assets.originalPath(latest.value.assetId!))).duration,
      ).toBeCloseTo(0.5, 1)
    },
    30_000,
  )

  it('实际合成中取消精确runId，清理临时文件且保留旧成片，之后可重试', async () => {
    const f = await fixture()
    setParams(f.doc, f.node, { shots: f.shots(300) })
    const runId = await f.start()
    await until(() => (f.doc.get(f.node)?.run?.progress ?? 0) > 0, 20_000)
    expect(
      (
        await request(f.server, `${f.endpoint}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ runId: 'old-run' }),
        })
      ).status,
    ).toBe(409)
    const response = await request(f.server, `${f.endpoint}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ runId }),
    })
    expect(response.status).toBe(204)
    expect(await f.server.runs.wait(runId)).toBe('canceled')
    expect(f.server.runs.store.get(runId)?.status).toBe('canceled')
    expect(f.doc.get(f.node)?.run?.status).toBe('canceled')
    expect(f.snapshot()).toEqual(f.previous)
    await until(() => readdirSync(join(f.dataDir, 'tmp')).every((name) => !name.startsWith('job-')))
    setParams(f.doc, f.node, { shots: f.shots(0.5) })
    expect(await f.server.runs.wait(await f.start())).toBe('succeeded')
    await until(() => f.doc.get(f.node)?.deliveries?.length === 2)
    expect(f.snapshot().results).toHaveLength(2)
  }, 30_000)
})
