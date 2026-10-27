import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { connect, createElement, setParams } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { documentReferences } from '../media-index/references'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

afterEach(() => vi.restoreAllMocks())

it('基础场景保持兼容，视角旧名只用该视角图；强引用、删除与缺图均可靠', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const assets: string[] = []
  for (let i = 0; i < 3; i++) {
    const asset = await server.assets.ingest(
      'local',
      Readable.from([solidPng(32, 24, [i * 60, 90, 100])]),
      { mime: 'image/png', name: `scene-${i}.png` },
    )
    assets.push(asset.id)
  }
  const views = [
    {
      id: 'door',
      name: '门口正拍',
      aliases: ['门口'],
      description: '黑板在右边',
      images: [assets[1]],
    },
    { id: 'window', name: '窗边', aliases: [], description: '逆光', images: [assets[2]] },
  ]
  const scene = addNode(doc, 'plein/scene', {
    name: '教室',
    params: { description: '一楼教室', sceneViews: views },
  })
  const base = createElement(doc, {
    kind: 'image',
    assetId: assets[0],
    x: 0,
    y: 0,
    w: 32,
    h: 24,
  })
  connect(doc, [base, 'image'], [scene, 'references'])
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@教室 学生走入' },
  })
  const preview = async () => {
    const res = await request(server, `/api/canvases/${id}/nodes/${image}/input`)
    expect(res.status).toBe(200)
    return (await res.json()) as PreparedInput
  }

  const baseInput = await preview()
  expect(baseInput.status).toBe('ready')
  expect(baseInput.inputs.references?.map((v) => v.assetId)).toEqual([assets[0]])

  const viewRefs = documentReferences(doc).filter((ref) => ref.nodeId === scene)
  expect(viewRefs.map((ref) => ref.assetId)).toEqual(expect.arrayContaining([assets[1], assets[2]]))
  expect(viewRefs).toHaveLength(2)
  expect(viewRefs.every((ref) => ref.explicit)).toBe(true)

  setParams(doc, image, { prompt: '@教室/门口 学生走入' })
  const input = await preview()
  expect(input.status).toBe('ready')
  expect(input.prompt).toContain('教室（门口正拍）')
  expect(input.prompt).toContain('一楼教室；黑板在右边')
  expect(input.inputs.references?.map((v) => v.assetId)).toEqual([assets[1]])
  expect(input.refs[0]?.available).toEqual([assets[1]])

  const seen: unknown[] = []
  const submit = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
    seen.push(req)
    return submit.call(mockProvider, req, ctx)
  })
  const run = await request(server, `/api/canvases/${id}/nodes/${image}/run`, {
    method: 'POST',
    body: JSON.stringify({ expect: input.inputHash }),
  })
  expect(run.status).toBe(202)
  const started = (await run.json()) as { runId: string }
  await until(() => seen.length > 0)
  expect(JSON.stringify(seen[0])).toContain(assets[1])
  expect(JSON.stringify(seen[0])).not.toContain(assets[0])
  expect(await server.runs.wait(started.runId)).toBe('succeeded')

  setParams(doc, scene, { sceneViews: [views[1]] })
  const unknown = await preview()
  expect(unknown.status).toBe('unprepared')
  expect(unknown.inputHash).toBeUndefined()
  expect(unknown.blocked[0]?.message).toContain('视角「门口」不存在')
  const unknownRun = server.runs.start(id, image, 'local')
  expect(await server.runs.wait(unknownRun)).toBe('failed')
  expect(seen).toHaveLength(1)

  setParams(doc, scene, { sceneViews: [{ ...views[0], images: [] }] })
  const missing = await preview()
  expect(missing.status).toBe('blocked')
  expect(missing.blocked[0]?.message).toContain('没有参考图')
  expect(missing.inputs.references ?? []).toEqual([])
  expect(missing.refs[0]?.available).toEqual([])
  const missingRun = server.runs.start(id, image, 'local')
  expect(await server.runs.wait(missingRun)).toBe('failed')
  expect(seen).toHaveLength(1)

  const expectInvalid = async (images: string[]) => {
    setParams(doc, scene, { sceneViews: [{ ...views[0], images }] })
    const invalid = await preview()
    expect(invalid.status).toBe('blocked')
    expect(invalid.blocked.map((issue) => issue.message).join('；')).toContain('参考图不可用')
    expect(invalid.inputs.references ?? []).toEqual([])
  }
  await expectInvalid(['f'.repeat(64)])

  const video = await server.assets.ingest('local', Readable.from(['not-an-image']), {
    mime: 'video/mp4',
    name: 'wrong-kind.mp4',
  })
  await expectInvalid([video.id])

  const missingImage = assets[1]!
  await rm(server.assets.originalPath(missingImage), { force: true })
  await expectInvalid([missingImage])

  setParams(doc, scene, {
    sceneViews: [
      {
        ...views[0],
        images: [assets[2]],
        panorama: { assetId: missingImage, yaw: 0, pitch: 0, fov: 55, format: 'landscape' },
      },
    ],
  })
  const screenshot = await preview()
  expect(screenshot.status).toBe('ready')
  expect(screenshot.inputs.references?.map((value) => value.assetId)).toEqual([assets[2]])
})
