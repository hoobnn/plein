import { fileURLToPath } from 'node:url'
import type { Canvas, McpServerView, McpToolInfo } from '@plein/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Approvals } from '../agent/approvals'
import { AgentChanges } from '../agent/changes'
import { McpServer } from '../agent/mcp'
import { agentTools, canvasTools, type ToolEnv } from '../agent/tools'
import { request, startTestServer } from '../testing'

const FIXTURE = fileURLToPath(new URL('../../test-fixtures/mcp-server.mjs', import.meta.url))

let running: Awaited<ReturnType<typeof startTestServer>>
let server: McpServerView
let canvasId: string
let seq = 0

beforeAll(async () => {
  running = await startTestServer()
  const res = await request(running.server, '/api/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({
      name: '测试服务',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      secrets: { GREETING: '你好，' },
    }),
  })
  expect(res.status).toBe(201)
  server = (await res.json()) as McpServerView
  const canvas = await request(running.server, '/api/canvases', { method: 'POST', body: '{}' })
  canvasId = ((await canvas.json()) as Canvas).id
})

afterAll(() => running.server.mcp?.close())

function env(): ToolEnv {
  const { rooms, runs, plugins, assets, library, mcp } = running.server
  return { canvasId, ownerId: 'local', rooms, runs, host: plugins, assets, library, mcp: mcp! }
}

function mcpOf(tools: ReturnType<typeof canvasTools>) {
  const s = new McpServer({ name: 'plein', version: 'test' }, tools)
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await s.handle({
      jsonrpc: '2.0',
      id: ++seq,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as {
      result: {
        content: Array<{ type: string; text?: string; mimeType?: string }>
        isError?: boolean
      }
    }
    return {
      error: r.result.isError === true,
      text: r.result.content.find((c) => c.type === 'text')?.text ?? '',
      content: r.result.content,
    }
  }
}

describe('外部 MCP 服务', () => {
  it('设置：保存时不回传密钥值，连上后列出工具', async () => {
    expect(server).toMatchObject({ transport: 'stdio', secretKeys: ['GREETING'], enabled: true })
    expect(JSON.stringify(server)).not.toContain('你好')
    const res = await request(running.server, `/api/mcp/servers/${server.id}/tools`)
    const tools = (await res.json()) as McpToolInfo[]
    expect(tools.map((t) => t.name)).toEqual(['echo', 'swatch', 'fail'])
    expect(tools.find((t) => t.name === 'swatch')?.readOnly).toBe(true)
    expect(tools[0]?.inputSchema).toMatchObject({ required: ['text'] })

    const bad = await request(running.server, '/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', transport: 'stdio' }),
    })
    expect(bad.status).toBe(400)
  })

  it('MCP 工具节点：上游文字填进参数，文字和图片从各自的口出来', async () => {
    const call = mcpOf(canvasTools(env()))
    const text = JSON.parse(
      (await call('create_node', { type: 'plein/text', params: { text: '雨夜' } })).text,
    ).id as string
    const node = JSON.parse(
      (
        await call('create_node', {
          type: 'plein/mcp-tool',
          params: { server: server.id, tool: 'echo', arguments: '{"text": "{{input}}天台"}' },
        })
      ).text,
    ).id as string
    await call('connect', { from: text, to: node, to_port: 'input' })
    const ran = await call('run_node', { id: node, wait_seconds: 20 })
    expect(ran.error).toBe(false)
    expect(ran.text).toContain('你好，雨夜天台')

    const image = JSON.parse(
      (
        await call('create_node', {
          type: 'plein/mcp-tool',
          params: { server: server.id, tool: 'swatch' },
        })
      ).text,
    ).id as string
    await call('run_node', { id: image, wait_seconds: 20 })
    const results = running.server.rooms.withDoc(canvasId, (doc) => doc.get(image)?.results ?? [])
    expect(results.map((r) => [r.port, r.value.type])).toEqual([
      ['text', 'text'],
      ['images', 'image'],
    ])

    const broken = JSON.parse(
      (
        await call('create_node', {
          type: 'plein/mcp-tool',
          params: { server: server.id, tool: 'fail' },
        })
      ).text,
    ).id as string
    const failed = await call('run_node', { id: broken, wait_seconds: 20 })
    expect(failed.text).toContain('坏掉了')
  })

  it('智能体能力：列工具、直接调用；会改外部状态的要确认，声明只读的不问', async () => {
    const { rooms, runs } = running.server
    const changes = new AgentChanges('agt_mcp', canvasId, 'local', rooms, runs)
    const approvals = new Approvals(() => {})
    const call = mcpOf(agentTools(env(), { changes, approvals, mode: () => 'rules' }))
    changes.begin('t1')

    const listed = JSON.parse((await call('mcp_list_tools')).text)
    expect(listed[0]).toMatchObject({ server: server.id, name: '测试服务' })
    expect(listed[0].tools.map((t: { name: string }) => t.name)).toContain('echo')

    const swatch = await call('mcp_call_tool', { server: server.id, tool: 'swatch' })
    expect(swatch.content.map((c) => c.type)).toEqual(['text', 'image'])

    const echo = JSON.parse(
      (await call('mcp_call_tool', { server: server.id, tool: 'echo', arguments: { text: 'x' } }))
        .text,
    )
    expect(echo.status).toBe('needs_approval')
    approvals.decide(echo.approval_id, true)
    const done = await call('await_approval', { approval_id: echo.approval_id })
    expect(done.text).toBe('你好，x')
    changes.release()
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
