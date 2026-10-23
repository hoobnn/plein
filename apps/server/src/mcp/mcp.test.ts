import type { Canvas } from '@plein/protocol'
import { createElement } from '@plein/doc'
import {
  definePlugin,
  definePluginCapability,
  defineServerPlugin,
  PLUGIN_API_VERSION,
} from '@plein/plugin-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { bootServer, createCanvas, request, startTestServer } from '../testing'

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
  it('captures awareness selection per request and keeps it stable throughout an asynchronous plugin call', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let waitNext = true
    server.plugins.load(
      [
        defineServerPlugin(
          definePlugin({
            manifest: {
              id: 'acme/selection',
              version: '1.0.0',
              name: 'selection',
              engines: { plein: `^${PLUGIN_API_VERSION}` },
              contributes: { capabilities: ['acme/selection'] },
            },
          }),
          {
            capabilities: [
              definePluginCapability({
                id: 'acme/selection',
                title: 'selection',
                description: '',
                effect: 'read',
                input: z.object({}),
                run: async (ctx) => {
                  if (waitNext) {
                    waitNext = false
                    entered()
                    await waiting
                  }
                  return { selection: ctx.selection, builtin: await ctx.call('ui_get_selection') }
                },
              }),
            ],
          },
        ),
      ],
      false,
    )
    try {
      const [first, second] = ['first', 'second'].map((name) =>
        createElement(doc, {
          kind: 'markdown',
          name,
          x: 0,
          y: 0,
          w: 100,
          h: 100,
        }),
      )
      const selection = [first!]
      const view = (ids: string[]) =>
        server.rooms.get(canvasId).awareness.setLocalState({
          view: {
            selection: ids,
            viewport: { x: 0, y: 0, w: 800, h: 600 },
            at: Date.now(),
          },
        })
      view(selection)
      const { token } = (await (
        await request(server, '/api/mcp/external', { method: 'POST' })
      ).json()) as { token: string }
      let sequence = 0
      const call = async (name: string) => {
        const response = await server.app.request('/mcp', {
          method: 'POST',
          headers: {
            host: '127.0.0.1:8787',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++sequence,
            method: 'tools/call',
            params: { name, arguments: { canvas_id: canvasId } },
          }),
        })
        const body = (await response.json()) as {
          result: { content: Array<{ text: string }>; isError?: boolean }
        }
        expect(body.result.isError).not.toBe(true)
        return JSON.parse(body.result.content[0]!.text)
      }
      expect(await call('ui_get_selection')).toMatchObject({ total: 1, elements: [{ id: first }] })
      const pending = call('acme__selection')
      await started
      selection[0] = second!
      view([second!])
      release()
      expect(await pending).toMatchObject({
        selection: [first],
        builtin: { total: 1, elements: [{ id: first }] },
      })
      expect(await call('ui_get_selection')).toMatchObject({ total: 1, elements: [{ id: second }] })
      expect(await call('acme__selection')).toMatchObject({
        selection: [second],
        builtin: { total: 1, elements: [{ id: second }] },
      })
      server.rooms.get(canvasId).awareness.setLocalState(null)
      expect(await call('ui_get_selection')).toMatchObject({ total: 0, elements: [] })
    } finally {
      release()
      doc.destroy()
    }
  })

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
