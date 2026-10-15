import { addResults, connect, type PleinDoc, setParams } from '@plein/doc'
import { defaultStageScene, STAGE_TYPE } from '@plein/nodes'
import type { PreparedInput } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

const preview = async (server: Server, canvas: string, node: string) => {
  const res = await request(server, `/api/canvases/${canvas}/nodes/${node}/input`)
  expect(res.status).toBe(200)
  return (await res.json()) as PreparedInput
}

/** 网页截图后写入的结果：一张不可变的图片资产 */
function snapshot(doc: PleinDoc, stage: string, assetId: string, n: number) {
  addResults(doc, stage, [
    {
      id: `res-${n}`,
      port: 'image',
      value: { type: 'image', assetId, mime: 'image/png' },
      runId: `snap-${n}`,
      at: n,
    },
  ])
}

describe('3D 构图', () => {
  it('截图作为参考图进入实际输入；改场景不影响已有截图，重新截图才换参考', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id: canvas, doc } = await createCanvas(server)
    const stage = addNode(doc, STAGE_TYPE, { name: '天台对峙', x: -400 })
    const shot = addNode(doc, 'plein/image', {
      params: { model: 'plein/mock:image', prompt: '按参考图的构图和人物站位，雨夜天台对峙' },
    })
    connect(doc, [stage, 'image'], [shot, 'references'])

    // 还没截图：没有构图参考，也不阻断
    const empty = await preview(server, canvas, shot)
    expect(empty.inputs.references ?? []).toEqual([])
    expect(empty.blocked).toEqual([])

    snapshot(doc, stage, 'a'.repeat(64), 1)
    const first = await preview(server, canvas, shot)
    expect(first.inputs.references).toEqual([
      expect.objectContaining({ assetId: 'a'.repeat(64), source: stage, resultId: 'res-1' }),
    ])

    // 继续摆场景（参数变了）：下游用的还是那张截图，实际输入不变
    const scene = defaultStageScene()
    setParams(doc, stage, {
      scene: { ...scene, rev: 3, figures: [{ ...scene.figures[0]!, x: 1.5, pose: 'point' }] },
    })
    expect((await preview(server, canvas, shot)).inputHash).toBe(first.inputHash)

    // 重新截图：新资产、新结果，下游实际输入跟着变
    snapshot(doc, stage, 'b'.repeat(64), 2)
    const second = await preview(server, canvas, shot)
    expect(second.inputs.references).toEqual([
      expect.objectContaining({ assetId: 'b'.repeat(64), resultId: 'res-2' }),
    ])
    expect(second.inputHash).not.toBe(first.inputHash)
  })
})
