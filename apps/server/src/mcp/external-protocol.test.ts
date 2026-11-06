import type { Canvas } from '@plein/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

/** 起真实服务，用 JSON-RPC 请求测外部 MCP 的协议层行为 */
let running: Awaited<ReturnType<typeof bootServer>>
let canvasId: string
let seq = 0

beforeAll(async () => {
  running = await bootServer()
  canvasId = (
    (await (
      await request(running.server, '/api/canvases', { method: 'POST', body: '{}' })
    ).json()) as Canvas
  ).id
})
afterAll(() => running.close())

// oxlint-disable-next-line typescript/no-explicit-any -- 测试里按需取 JSON-RPC 响应字段
type Json = Record<string, any>
interface Rpc {
  result: Json
  error?: { code: number; message: string; data?: Json }
}

async function issue(scopes?: string[], extra: Record<string, unknown> = {}) {
  const res = await request(running.server, '/api/mcp/external', {
    method: 'POST',
    body: JSON.stringify({ name: 't', ...(scopes ? { scopes } : {}), ...extra }),
  })
  return (await res.json()) as { token: string; id: string }
}

function client(token: string) {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    running.server.app.request('/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    })
  const rpc = async (method: string, params?: unknown): Promise<Rpc> =>
    (await (await post({ jsonrpc: '2.0', id: ++seq, method, params })).json()) as Rpc
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await rpc('tools/call', { name, arguments: { canvas_id: canvasId, ...args } }))
      .result
    const text: string = r.content[0]?.text ?? ''
    return {
      isError: r.isError === true,
      text,
      sc: r.structuredContent as Json | undefined,
      json: () => JSON.parse(text),
    }
  }
  return { post, rpc, call }
}

describe('外部 MCP 协议层', () => {
  it('tools/list 带 annotations，并按令牌 scope 过滤', async () => {
    const full = client((await issue()).token)
    const tools = (await full.rpc('tools/list')).result.tools as Array<{
      name: string
      annotations: Record<string, boolean>
    }>
    const by = (n: string) => tools.find((t) => t.name === n)!.annotations
    expect(by('get_canvas')).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(by('create_element')).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(by('delete_elements')).toMatchObject({ destructiveHint: true })
    expect(by('run_node')).toMatchObject({ readOnlyHint: false, openWorldHint: true })
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['undo_call', 'ui_set_viewport']),
    )

    const ro = client((await issue(['read'])).token)
    const names = ((await ro.rpc('tools/list')).result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    )
    expect(names).toContain('get_canvas')
    expect(names).not.toContain('create_element')
    expect(names).not.toContain('run_node')
    expect(names).not.toContain('delete_elements')
  })

  it('越权调用被拒绝，拒绝信息可操作并带 forbidden_scope', async () => {
    const ro = client((await issue(['read'])).token)
    const r = await ro.call('create_element', { kind: 'markdown', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.sc?.error.code).toBe('forbidden_scope')
    expect(r.text).toContain('edit 权限')
    expect(r.text).toContain('设置')
  })

  it('错误码：not_found、invalid_params（带 issues）', async () => {
    const c = client((await issue()).token)
    const nf = await c.call('get_element', { id: 'nope' })
    expect(nf.sc?.error.code).toBe('not_found')
    const bad = await c.call('get_element', { id: 5 })
    expect(bad.sc?.error.code).toBe('invalid_params')
    expect(bad.sc?.error.issues[0]).toMatchObject({ path: 'id' })
  })

  it('变更类调用：client_request_id 幂等，undo_token 可撤销', async () => {
    const c = client((await issue()).token)
    const args = { kind: 'markdown', text: '幂等', client_request_id: 'req-1' }
    const first = await c.call('create_element', args)
    expect(first.isError).toBe(false)
    const id = first.json().id as string
    const replay = await c.call('create_element', args)
    expect(replay.sc?.replayed).toBe(true)
    expect(replay.json().id).toBe(id)
    const other = await c.call('create_element', { ...args, text: '不同内容' })
    expect(other.sc?.error.code).toBe('invalid_params')

    const token = first.sc?.undo_token as string
    expect(token).toBeTruthy()
    expect(running.server.rooms.withDoc(canvasId, (d) => !!d.get(id))).toBe(true)
    // 别的令牌不能撤销
    const stranger = client((await issue()).token)
    expect((await stranger.call('undo_call', { token })).sc?.error.code).toBe('not_found')
    expect((await c.call('undo_call', { token })).text).toBe('已撤销')
    expect(running.server.rooms.withDoc(canvasId, (d) => !!d.get(id))).toBe(false)
    expect((await c.call('undo_call', { token })).sc?.error.code).toBe('not_found')
  })

  it('破坏性操作先返回 needs_approval，带 confirm 才执行；没有 destructive scope 直接拒', async () => {
    const c = client((await issue()).token)
    const made = await c.call('create_element', { kind: 'markdown', text: '待删' })
    const id = made.json().id as string
    const ask = await c.call('delete_elements', { ids: [id] })
    expect(ask.isError).toBe(false)
    expect(ask.json().status).toBe('needs_approval')
    expect(ask.sc?.code).toBe('needs_user')
    expect(running.server.rooms.withDoc(canvasId, (d) => !!d.get(id))).toBe(true)
    const done = await c.call('delete_elements', { ids: [id], confirm: true })
    expect(done.isError).toBe(false)
    expect(running.server.rooms.withDoc(canvasId, (d) => !!d.get(id))).toBe(false)

    const noDestructive = client((await issue(['read', 'edit'])).token)
    const denied = await noDestructive.call('delete_elements', { ids: ['x'], confirm: true })
    expect(denied.sc?.error.code).toBe('forbidden_scope')
  })

  it('工作区工具的 canvas_id 是自己的参数：外部可以重命名、删除画布', async () => {
    const c = client((await issue()).token)
    const raw = async (name: string, args: Record<string, unknown>) =>
      (await c.rpc('tools/call', { name, arguments: args })).result
    const made = await raw('create_canvas', { title: '外部新建' })
    const id = JSON.parse(made.content[0].text).canvas_id as string
    const renamed = await raw('rename_canvas', { canvas_id: id, title: '外部改名' })
    expect(renamed.isError).not.toBe(true)
    const listed = JSON.parse((await raw('list_canvases', {})).content[0].text)
    expect(JSON.stringify(listed)).toContain('外部改名')
    const ask = await raw('delete_canvas', { canvas_id: id })
    expect(JSON.parse(ask.content[0].text).status).toBe('needs_approval')
    const done = await raw('delete_canvas', { canvas_id: id, confirm: true })
    expect(done.isError).not.toBe(true)
    expect(
      JSON.stringify(JSON.parse((await raw('list_canvases', {})).content[0].text)),
    ).not.toContain(id)
  })

  it('每日运行次数上限', async () => {
    const issued = await issue(['read', 'run'], { dailyRunLimit: 1 })
    const c = client(issued.token)
    // 节点不存在：预检失败不计次，所以上限不会被耗尽
    const miss = await c.call('run_node', { id: 'nope', confirm: true })
    expect(miss.isError).toBe(true)
    expect(miss.sc?.error.code).not.toBe('rate_limited')
  })

  it('输出超限不返回原文，提示分页', async () => {
    const c = client((await issue()).token)
    const made = await c.call('create_element', { kind: 'markdown', text: 'x'.repeat(60_000) })
    const id = made.json().id as string
    const big = await c.call('get_element', { id })
    expect(big.isError).toBe(true)
    expect(big.sc?.error.code).toBe('too_large')
    expect(big.text).toContain('get_element_field')
  })

  it('ui 动作：没有标签页时给准确提示，有标签页时经 awareness 推送；ui_select 可清空', async () => {
    const c = client((await issue()).token)
    const awareness = running.server.rooms.get(canvasId).awareness
    awareness.setLocalState(null)
    expect((await c.call('ui_select', { ids: [] })).text).toContain('没有在浏览器')
    expect((await c.call('ui_set_viewport', { x: 10, y: 20, zoom: 2 })).text).toContain(
      '没有在浏览器',
    )
    awareness.setLocalState({
      view: { selection: [], viewport: { x: 0, y: 0, w: 800, h: 600 }, at: Date.now() },
    })
    expect((await c.call('ui_select', { ids: [] })).text).toBe('已在用户屏幕上完成')
    await c.call('ui_set_viewport', { x: 10, y: 20, zoom: 2 })
    const actions = awareness.getLocalState()!.agentUi.actions
    expect(actions.map((a: Json) => a.action)).toEqual(['select', 'viewport'])
    expect(actions[0].ids).toEqual([])
    expect(actions[1]).toMatchObject({ x: 10, y: 20, zoom: 2 })
    expect(actions[1].n).toBeGreaterThan(actions[0].n)
    awareness.setLocalState(null)
  })

  it('prompts：五个技能；resources：画布分页、元素、能力契约', async () => {
    const c = client((await issue()).token)
    const init = (await c.rpc('initialize', { protocolVersion: '2025-06-18' })).result
    expect(init.capabilities).toHaveProperty('resources')
    expect(init.capabilities).toHaveProperty('prompts')

    const prompts = (await c.rpc('prompts/list')).result.prompts as Array<{
      name: string
      arguments: Array<{ name: string; required?: boolean }>
    }>
    expect(prompts.map((p) => p.name).sort()).toEqual(
      ['canvas-audit', 'media-edit', 'shot-revise', 'storyboard', 'workflow'].sort(),
    )
    const got = (
      await c.rpc('prompts/get', { name: 'canvas-audit', arguments: { goal: '看看缺什么' } })
    ).result
    expect(got.messages[0].content.text).toContain('get_canvas_page')
    expect(got.messages[0].content.text).toContain('看看缺什么')
    expect(got.messages[0].content.text).not.toContain('await_approval')
    expect((await c.rpc('prompts/get', { name: 'nope' })).error?.code).toBe(-32602)

    const list = (await c.rpc('resources/list')).result
    expect(list.resources.map((r: Json) => r.uri)).toContain(`plein://canvas/${canvasId}`)
    expect((await c.rpc('resources/templates/list')).result.resourceTemplates).toHaveLength(3)
    const made = await c.call('create_element', { kind: 'markdown', text: '资源' })
    const eid = made.json().id as string
    const canvas = (await c.rpc('resources/read', { uri: `plein://canvas/${canvasId}?limit=1` }))
      .result
    expect(JSON.parse(canvas.contents[0].text)).toMatchObject({ section: 'elements' })
    const el = (await c.rpc('resources/read', { uri: `plein://canvas/${canvasId}/element/${eid}` }))
      .result
    expect(JSON.parse(el.contents[0].text).id).toBe(eid)
    const cap = (await c.rpc('resources/read', { uri: 'plein://capabilities/get_canvas' })).result
    expect(JSON.parse(cap.contents[0].text)).toMatchObject({ name: 'get_canvas', effect: 'read' })
    const missing = await c.rpc('resources/read', { uri: 'plein://canvas/nope' })
    expect(missing.error?.code).toBe(-32602)
    expect(missing.error?.data?.uri).toBe('plein://canvas/nope')

    const noRead = client((await issue(['edit'])).token)
    expect((await noRead.rpc('resources/list')).error?.data?.code).toBe('forbidden_scope')
  })

  it('resources/list 分页', async () => {
    const c = client((await issue()).token)
    for (let i = 0; i < 21; i++)
      await request(running.server, '/api/canvases', { method: 'POST', body: '{}' })
    const first = (await c.rpc('resources/list')).result
    expect(first.resources).toHaveLength(20)
    expect(first.nextCursor).toBeTruthy()
    const second = (await c.rpc('resources/list', { cursor: first.nextCursor })).result
    expect(second.resources.length).toBeGreaterThan(0)
  })

  it('带 progressToken 并接受 SSE 时，工具调用走事件流', async () => {
    const c = client((await issue()).token)
    const res = await c.post(
      {
        jsonrpc: '2.0',
        id: ++seq,
        method: 'tools/call',
        params: { name: 'list_canvases', arguments: {}, _meta: { progressToken: 'p1' } },
      },
      { accept: 'application/json, text/event-stream' },
    )
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('data: ')
    expect(text).toContain('"result"')
  })

  it('撤销令牌后立即失效，审计日志记录工具与令牌名但不含参数', async () => {
    const issued = await issue(undefined, { name: '审计用' })
    const c = client(issued.token)
    await c.call('create_element', { kind: 'markdown', text: '机密正文内容' })
    const audit = (await (
      await request(running.server, '/api/mcp/external/audit')
    ).json()) as Array<{
      token: string
      tool: string
      ok: boolean
    }>
    const hit = audit.find((a) => a.token === '审计用' && a.tool === 'create_element')
    expect(hit?.ok).toBe(true)
    expect(JSON.stringify(audit)).not.toContain('机密正文内容')
    await request(running.server, `/api/mcp/external/${issued.id}`, { method: 'DELETE' })
    expect((await c.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
  })
})
