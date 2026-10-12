import { createElement, type PleinDoc, updateElement } from '@plein/doc'
import type { Canvas } from '@plein/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { startTestServer } from '../testing'
import { AgentChanges } from './changes'
import { McpServer } from './mcp'
import { canvasTools } from './tools'

let running: Awaited<ReturnType<typeof startTestServer>>
let mcp: McpServer
let canvasId: string

beforeAll(async () => {
  running = await startTestServer()
  const res = await fetch(`${running.url}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  canvasId = ((await res.json()) as Canvas).id
  const { rooms, runs, plugins, assets } = running.server
  mcp = new McpServer(
    { name: 'plein', version: 'test' },
    canvasTools({ canvasId, ownerId: 'local', rooms, runs, host: plugins, assets }),
  )
})

let seq = 0
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await mcp.handle({
    jsonrpc: '2.0',
    id: ++seq,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result: { content: Array<{ type: string; text?: string }>; isError?: boolean } }
  const text = res.result.content.find((c) => c.type === 'text')?.text ?? ''
  return { error: res.result.isError === true, text, json: () => JSON.parse(text) }
}

describe('智能体 MCP', () => {
  it('握手与工具列表', async () => {
    const init = (await mcp.handle({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })) as { result: { protocolVersion: string } }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string; inputSchema: { type: string } }> }
    }
    const create = list.result.tools.find((t) => t.name === 'create_node')
    expect(create?.inputSchema.type).toBe('object')
  })

  it('建节点、连线、运行，结果写回画布', async () => {
    const text = (
      await call('create_node', { type: 'plein/text', params: { text: '雨夜天台' } })
    ).json()
    const image = await call('create_node', {
      type: 'plein/image',
      near: text.id,
      inputs: [{ from: text.id }],
    })
    expect(image.error).toBe(false)
    const imageId = image.json().id as string
    // 放在参照元素右侧，不重叠
    const canvas = (await call('get_canvas')).json()
    const rect = (id: string) => canvas.elements.find((e: { id: string }) => e.id === id).rect
    expect(rect(imageId)[0]).toBeGreaterThan(rect(text.id)[0] + rect(text.id)[2])
    expect(canvas.edges).toHaveLength(1)

    const run = (await call('run_node', { id: imageId, wait_seconds: 10 })).json()
    expect(run.status).toBe('succeeded')
    expect(run.results[0].type).toBe('image')
    const view = (await mcp.handle({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'view_media', arguments: { element_id: imageId } },
    })) as { result: { content: Array<{ type: string; mimeType?: string }> } }
    expect(view.result.content.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg')).toBe(
      true,
    )
    // 加工与工具条同一实现：产物作为新元素放在旁边，参数不对或类型不符时说明原因
    const rotated = await call('edit_media', { element_id: imageId, op: 'rotate', angle: 90 })
    expect(rotated.error).toBe(false)
    const [made] = rotated.json().elements
    expect(made).toMatchObject({ kind: 'image' })
    expect(
      (await call('get_canvas')).json().elements.some((e: { id: string }) => e.id === made.id),
    ).toBe(true)
    const badAngle = await call('edit_media', { element_id: imageId, op: 'rotate', angle: 45 })
    expect(badAngle.text).toContain('参数不对')
    const wrongKind = await call('edit_media', { element_id: imageId, op: 'trim', end: 1 })
    expect(wrongKind.error).toBe(true)
  })

  it('参数不对、元素不存在时把原因告诉模型', async () => {
    const bad = await call('create_node', { type: 'plein/image', params: { count: 99 } })
    expect(bad.error).toBe(true)
    expect(bad.text).toContain('参数不对')
    const missing = await call('update_element', { id: 'nope', name: 'x' })
    expect(missing.error).toBe(true)
    expect(missing.text).toContain('不存在')
  })

  it('MCP 入口要求会话令牌', async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('智能体改动集与撤销', () => {
  async function setup() {
    const res = await fetch(`${running.url}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const id = ((await res.json()) as Canvas).id
    const { rooms, runs, plugins, assets } = running.server
    const touched: string[][] = []
    const changes = new AgentChanges('agt_test', id, rooms, runs, (ids) => touched.push(ids))
    const ai = new McpServer(
      { name: 'plein', version: 'test' },
      canvasTools({
        canvasId: id,
        ownerId: 'local',
        rooms,
        runs,
        host: plugins,
        assets,
        origin: changes.origin,
        onRun: (n, r) => changes.recordRun(n, r),
      }),
    )
    const aiCall = async (name: string, args: Record<string, unknown>) => {
      const r = (await ai.handle({
        jsonrpc: '2.0',
        id: ++seq,
        method: 'tools/call',
        params: { name, arguments: args },
      })) as { result: { content: Array<{ text?: string }>; isError?: boolean } }
      expect(r.result.isError).not.toBe(true)
      return JSON.parse(r.result.content[0]!.text!)
    }
    const doc = <T>(fn: (d: PleinDoc) => T) => rooms.withDoc(id, fn)
    return { changes, aiCall, doc, touched }
  }

  it('撤销一轮：删掉 AI 新建的、恢复 AI 改的，人后来改过的保留', async () => {
    const { changes, aiCall, doc, touched } = await setup()
    // 用户先建好两个元素
    const [mine, other] = doc((d) => [
      createElement(d, { kind: 'markdown', x: 0, y: 0, w: 200, h: 100, text: '原文' }),
      createElement(d, { kind: 'markdown', x: 0, y: 300, w: 200, h: 100, text: '另一个' }),
    ])

    changes.begin('t1')
    const made = await aiCall('create_node', { type: 'plein/text', near: mine })
    await aiCall('update_element', { id: mine, text: 'AI 改写', x: 500 })
    await aiCall('update_element', { id: other, name: 'AI 起的名' })
    // 这一轮进行中，用户自己也建了一个、又把 AI 挪过的元素拖到别处
    const userMade = doc((d) =>
      createElement(d, { kind: 'markdown', x: 0, y: 600, w: 200, h: 100 }),
    )
    doc((d) => updateElement(d, mine, { x: 900 }))
    const summary = changes.end()!
    expect(summary.created).toEqual([made.id])
    expect(summary.updated.sort()).toEqual([mine, other].sort())
    expect(changes.canUndo('t1')).toBe(true)

    expect(changes.undoTurn('t1')).toBe(true)
    doc((d) => {
      expect(d.get(made.id)).toBeUndefined()
      expect(d.get(userMade)).toBeDefined()
      expect(d.get(mine)?.text).toBe('原文')
      // 用户的拖动保留，没被撤销覆盖
      expect(d.get(mine)?.x).toBe(900)
      expect(d.get(other)?.name).toBeUndefined()
    })
    expect(changes.canUndo('t1')).toBe(false)
    await new Promise((r) => setTimeout(r, 200))
    expect(touched.flat()).toContain(made.id)
    changes.release()
  })

  it('只能从最近一轮往回撤，运行记进改动集', async () => {
    const { changes, aiCall, doc } = await setup()
    changes.begin('t1')
    const a = await aiCall('create_node', { type: 'plein/text', params: { text: '雨夜' } })
    changes.end()
    changes.begin('t2')
    const b = await aiCall('create_node', { type: 'plein/image', inputs: [{ from: a.id }] })
    await aiCall('run_node', { id: b.id, wait_seconds: 0 })
    const summary = changes.end()!
    expect(summary.runs).toBe(1)
    expect(summary.edges).toBe(1)

    expect(changes.canUndo('t1')).toBe(false)
    expect(changes.undoTurn('t1')).toBe(false)
    expect(changes.undoTurn('t2')).toBe(true)
    doc((d) => {
      expect(d.get(b.id)).toBeUndefined()
      expect(d.get(a.id)).toBeDefined()
    })
    expect(changes.canUndo('t1')).toBe(true)
    expect(changes.undoTurn('t1')).toBe(true)
    doc((d) => expect(d.get(a.id)).toBeUndefined())
    changes.release()
  })

  it('释放后不能再撤销', async () => {
    const { changes, aiCall } = await setup()
    changes.begin('t1')
    await aiCall('create_node', { type: 'plein/text' })
    expect(changes.end()).not.toBeNull()
    changes.release()
    expect(changes.canUndo('t1')).toBe(false)
    expect(changes.undoTurn('t1')).toBe(false)
  })
})
