import { connect, createElement } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

const asset = (c: string) => c.repeat(64)

const preview = async (server: Server, canvas: string, node: string) => {
  const res = await request(server, `/api/canvases/${canvas}/nodes/${node}/input`)
  expect(res.status).toBe(200)
  return (await res.json()) as PreparedInput
}

/** LLM 节点连一张图：返回画布 id、节点 id */
const setup = async (server: Server, model: string) => {
  const { id, doc } = await createCanvas(server)
  const image = createElement(doc, {
    kind: 'image',
    name: 'a.png',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const llm = addNode(doc, 'plein/llm', {
    params: { model, prompt: '看图说话' },
    y: 300,
  })
  connect(doc, [image, 'image'], [llm, 'images'])
  return { canvas: id, llm }
}

describe('对话模型连图', () => {
  it('模型不支持看图：准备阶段就挡住，说清要换模型或断开图片', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { canvas, llm } = await setup(server, 'plein/mock:chat')
    const input = await preview(server, canvas, llm)
    expect(input.status).toBe('blocked')
    expect(input.blocked).toContainEqual({
      code: 'prepare_failed',
      message: '当前对话模型不支持看图，请换支持图片的模型或断开图片输入',
    })
  })

  it('模型支持看图：准备通过，图照常送入', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { canvas, llm } = await setup(server, 'plein/mock:agent-vision')
    const input = await preview(server, canvas, llm)
    expect(input.status).toBe('ready')
    expect(input.blocked).toEqual([])
    expect(input.inputs.images?.map((v) => v.assetId)).toEqual([asset('a')])
  })
})
