import { Readable } from 'node:stream'
import { referenceClipboard } from '@plein/capabilities'
import { createDoc } from '@plein/doc'
import type { PreparedInput, NodeRunStarted } from '@plein/protocol'
import type { CapabilityInput } from '@plein/plugin-sdk'
import { mockProvider } from '@plein/providers'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

afterEach(() => vi.restoreAllMocks())

it('跨画布同名角色复制后，预览、撤销重做、重启与生成使用正确档案素材', async () => {
  const first = await bootServer()
  const source = await createCanvas(first.server)
  const target = await createCanvas(first.server)
  const assets: string[] = []
  for (let i = 0; i < 3; i++) {
    const asset = await first.server.assets.ingest(
      'local',
      Readable.from([solidPng(32, 24, [i * 60, 100, 160])]),
      { mime: 'image/png', name: `copy-${i}.png` },
    )
    assets.push(asset.id)
  }
  const roles = assets.slice(0, 2).map((image) =>
    addNode(source.doc, 'plein/character', {
      name: '林夏 · 复制',
      params: {
        profile: {
          periods: [
            {
              id: 'young',
              name: '青年',
              aliases: [],
              description: '青年身份',
              images: [image],
              voice: null,
              voiceStates: [],
              outfits: [
                {
                  id: 'uniform',
                  name: '校服',
                  aliases: [],
                  description: '蓝白校服',
                  images: [assets[2]],
                },
              ],
            },
          ],
          expressions: [],
        },
      },
    }),
  )
  const chosen = [...roles].sort()[1]!
  const image = addNode(source.doc, 'plein/image', {
    params: {
      model: 'plein/mock:image',
      prompt: '@林夏 · 复制#2/青年/校服 站在窗前',
      requiredRefs: [chosen],
    },
  })
  const existing = addNode(target.doc, 'plein/character', { name: '林夏 · 复制' })
  const text = addNode(target.doc, 'plein/text', { params: { text: '@林夏 · 复制 留在这里' } })
  target.doc.undo.stopCapturing()
  const copied = referenceClipboard.paste(
    target.doc,
    JSON.parse(JSON.stringify(referenceClipboard.copy(source.doc, [...roles, image]))),
  )
  const node = copied[2]!
  const expected = [assets[roles.indexOf(chosen)], assets[2]]
  const preview = async (server: typeof first.server) => {
    const res = await request(server, `/api/canvases/${target.id}/nodes/${node}/input`)
    expect(res.status).toBe(200)
    return (await res.json()) as PreparedInput
  }
  const before = await preview(first.server)
  expect(before.status).toBe('ready')
  expect(before.refs[0]?.elementId).toBe(copied[roles.indexOf(chosen)])
  expect(before.refs[0]?.elementId).not.toBe(existing)
  expect(before.refs[0]?.required).toBe(true)
  expect(before.refs[0]?.name).toMatch(/#\d（青年·校服）/)
  expect(before.inputs.references?.map((v) => v.assetId)).toEqual(expected)
  expect(target.doc.get(text)?.params?.text).toMatch(/#\d/)
  target.doc.undo.undo()
  expect(target.doc.get(node)).toBeUndefined()
  expect(target.doc.get(text)?.params?.text).toBe('@林夏 · 复制 留在这里')
  target.doc.undo.redo()
  expect((await preview(first.server)).inputs.references).toEqual(before.inputs.references)
  source.doc.destroy()
  target.doc.destroy()
  await first.close()

  const { server } = await bootServer({ dataDir: first.dataDir })
  mockSettings(server, {})
  const reopened = await preview(server)
  expect(reopened.inputs.references?.map((v) => v.assetId)).toEqual(expected)
  const submit = vi.spyOn(mockProvider, 'submit')
  const response = await request(server, `/api/canvases/${target.id}/nodes/${node}/run`, {
    method: 'POST',
    body: '{}',
  })
  expect(response.status).toBe(202)
  expect(await server.runs.wait(((await response.json()) as NodeRunStarted).runId)).toBe(
    'succeeded',
  )
  expect(submit).toHaveBeenCalledTimes(1)
  expect(
    (submit.mock.calls[0]![0].input as CapabilityInput<'image.generate'>).references?.map(
      (v) => v.assetId,
    ),
  ).toEqual(expected)
  const doc = createDoc(server.rooms.get(target.id).doc, { schedule: () => {} })
  expect(doc.get(node)?.results).toHaveLength(1)
  doc.destroy()
})

it('只复制生成节点不会借用另一画布同名角色，运行阻断且不提交 Provider', async () => {
  const { server } = await bootServer()
  const source = await createCanvas(server)
  const target = await createCanvas(server)
  addNode(source.doc, 'plein/character', { name: '林夏', params: { description: '源角色' } })
  const image = addNode(source.doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏 站在窗前' },
  })
  addNode(target.doc, 'plein/character', { name: '林夏', params: { description: '同名其他角色' } })
  const [node] = referenceClipboard.paste(target.doc, referenceClipboard.copy(source.doc, [image]))
  const submit = vi.spyOn(mockProvider, 'submit')
  const res = await request(server, `/api/canvases/${target.id}/nodes/${node}/input`)
  expect(res.status).toBe(200)
  const input = (await res.json()) as PreparedInput
  expect(input.blocked.map((b) => b.message).join()).toContain('@林夏#0')
  expect(input.refs).toEqual([])
  const run = await request(server, `/api/canvases/${target.id}/nodes/${node}/run`, {
    method: 'POST',
    body: '{}',
  })
  expect(run.status).toBe(202)
  expect(await server.runs.wait(((await run.json()) as NodeRunStarted).runId)).toBe('failed')
  expect(submit).not.toHaveBeenCalled()
  expect(target.doc.get(node!)?.results ?? []).toEqual([])
  source.doc.destroy()
  target.doc.destroy()
})
