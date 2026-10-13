import type { Canvas } from '@plein/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request, startTestServer } from '../testing'

let running: Awaited<ReturnType<typeof startTestServer>>
let canvasId: string
let seq = 0

beforeAll(async () => {
  running = await startTestServer()
  const canvas = await request(running.server, '/api/canvases', { method: 'POST', body: '{}' })
  canvasId = ((await canvas.json()) as Canvas).id
})

afterAll(() => running.close())

describe('对外开放 MCP', () => {
  it('对外开放：长期令牌让外部应用用全部能力，不传画布时用用户正在看的', async () => {
    const { server: app } = running
    const { rooms } = app
    expect(await (await request(app, '/api/mcp/external')).json()).toEqual({ enabled: false })
    const issued = (await (await request(app, '/api/mcp/external', { method: 'POST' })).json()) as {
      token: string
    }
    expect(issued.token).toMatch(/^plein_/)

    const rpc = (body: unknown, token = issued.token) =>
      app.app.request('/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
    const list = (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: object } }> }
    }
    const names = list.result.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_canvases', 'get_canvas', 'create_node']))
    expect(
      list.result.tools.find((t) => t.name === 'get_canvas')?.inputSchema.properties,
    ).toHaveProperty('canvas_id')

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await (
        await rpc({
          jsonrpc: '2.0',
          id: ++seq,
          method: 'tools/call',
          params: { name, arguments: args },
        })
      ).json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }
      return { error: r.result.isError === true, text: r.result.content[0]?.text ?? '' }
    }
    const canvases = JSON.parse((await call('list_canvases')).text) as Array<{ id: string }>
    expect(canvases.map((c) => c.id)).toContain(canvasId)
    const made = await call('create_element', {
      canvas_id: canvasId,
      kind: 'markdown',
      text: '从外部写的',
    })
    expect(made.error).toBe(false)
    const id = JSON.parse(made.text).id as string
    expect(rooms.withDoc(canvasId, (doc) => doc.get(id)?.text)).toBe('从外部写的')
    expect((await call('get_canvas', { canvas_id: 'nope' })).text).toContain('没有画布')

    // 关掉后令牌失效
    await request(app, '/api/mcp/external', { method: 'DELETE' })
    expect((await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' })).status).toBe(401)
  })
})
