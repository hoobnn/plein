import { Readable } from 'node:stream'
import { connect, createElement, setParams } from '@plein/doc'
import type { AssetRef, ProviderRequest } from '@plein/plugin-sdk'
import type { JobList, PreparedInput } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

afterEach(() => vi.restoreAllMocks())

it('服饰移动后旧名引用使用新的时期图片和音色，预览、平台请求与任务快照一致', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const assets: string[] = []
  for (let i = 0; i < 4; i++) {
    const asset = await server.assets.ingest(
      'local',
      Readable.from([solidPng(32, 24, [i * 60, 100, 160])]),
      { mime: 'image/png', name: `profile-${i}.png` },
    )
    assets.push(asset.id)
  }
  const outfit = {
    id: 'uniform',
    name: '校服',
    aliases: ['旧校服'],
    description: '蓝白服饰',
    images: [assets[2]],
  }
  const teen = {
    id: 'teen',
    name: '少年',
    images: [assets[0]],
    voice: { provider: 'plein/mock', voiceId: 'mock-female' },
    outfits: [outfit],
  }
  const adult = {
    id: 'adult',
    name: '成年',
    images: [assets[1]],
    voice: { provider: 'plein/mock', voiceId: 'mock-male' },
    outfits: [],
  }
  const hero = addNode(doc, 'plein/character', {
    name: '林夏',
    params: { profile: { periods: [teen, adult], expressions: [] } },
  })
  const base = createElement(doc, {
    kind: 'image',
    assetId: assets[3],
    x: 0,
    y: 0,
    w: 32,
    h: 24,
  })
  connect(doc, [base, 'image'], [hero, 'references'])
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏/旧校服 走向窗边' },
  })
  const speech = addNode(doc, 'plein/speech', {
    params: { model: 'plein/mock:audio', text: '@林夏/旧校服 你好。' },
  })
  const video = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', mode: 'reference', prompt: '@林夏/旧校服 走向窗边' },
  })
  const seen: ProviderRequest[] = []
  const submit = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
    seen.push(req)
    return submit.call(mockProvider, req, ctx)
  })
  const preview = async (node: string) => {
    const res = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
    expect(res.status).toBe(200)
    return (await res.json()) as PreparedInput
  }
  const before = await preview(image)
  expect(before.inputs.references?.map((v) => v.assetId)).toEqual([assets[0], assets[2], assets[3]])
  expect((await preview(speech)).voice?.voiceId).toBe('mock-female')
  expect(seen).toEqual([])
  setParams(doc, hero, {
    profile: {
      periods: [
        { ...teen, outfits: [] },
        { ...adult, outfits: [outfit] },
      ],
      expressions: [],
    },
  })
  const stale = await request(server, `/api/canvases/${id}/nodes/${image}/run`, {
    method: 'POST',
    body: JSON.stringify({ expect: before.inputHash }),
  })
  expect(stale.status).toBe(409)
  expect(seen).toEqual([])
  for (const [node, port] of [
    [image, 'references'],
    [video, 'images'],
    [speech, null],
  ] as const) {
    const input = await preview(node)
    expect(input.status).toBe('ready')
    expect(input.prompt).toContain('林夏（成年·校服）')
    expect(input.prompt).not.toContain('少年')
    if (port)
      expect(input.inputs[port]?.map((v) => v.assetId)).toEqual([assets[1], assets[2], assets[3]])
    else expect(input.voice?.voiceId).toBe('mock-male')
    const res = await request(server, `/api/canvases/${id}/nodes/${node}/run`, {
      method: 'POST',
      body: JSON.stringify({ expect: input.inputHash }),
    })
    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    expect(await server.runs.wait(runId)).toBe('succeeded')
    await until(() => !server.runs.isRunning(id, node))
    const sent = seen.at(-1)!.input as {
      prompt?: string
      text?: string
      voice?: string
      references?: AssetRef[]
    }
    if (port) {
      expect(sent.references?.map((ref) => ref.assetId)).toEqual([assets[1], assets[2], assets[3]])
      expect(sent.prompt).toBe(input.prompt)
    } else {
      expect(sent.voice).toBe('mock-male')
      expect(sent.text).toBe(input.prompt)
    }
    const jobs = (await (await request(server, `/api/canvases/${id}/jobs`)).json()) as JobList
    expect(jobs.jobs.find((job) => job.id === runId)?.input).toEqual({
      ...input,
      preparedAt: expect.any(Number),
    })
  }
  expect(seen).toHaveLength(3)
}, 30_000)
