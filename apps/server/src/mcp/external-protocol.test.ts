import { join } from 'node:path'
import type { Canvas } from '@plein/protocol'
import { ProviderError } from '@plein/plugin-sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { insertCanvas, insertProject } from '../storage/canvases'
import { addNode, bootServer, mockModel, request, tempDir } from '../testing'
import { TokenStore } from './tokens'

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

function client(token: string, instance = running) {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    instance.server.app.request('/mcp', {
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
    expect(names).toContain('ui_get_viewport')
    expect(names).not.toContain('ui_focus')
    expect(names).not.toContain('ui_select')
    expect(names).not.toContain('ui_set_viewport')
    expect(names).not.toContain('create_element')
    expect(names).not.toContain('run_node')
    expect(names).not.toContain('delete_elements')
    expect(names).not.toContain('apply_edit_plan')
    expect(names).toContain('run_storyboard') // 预检是只读分支
    const catalogue = (await ro.call('list_canvas_capabilities')).json() as Array<{ name: string }>
    expect(catalogue.map((tool) => tool.name)).toEqual(names)
    expect(
      (await ro.call('list_canvas_capabilities', { name: 'delete_elements' })).sc?.error.code,
    ).toBe('not_found')
    expect(
      (await ro.rpc('resources/read', { uri: 'plein://capabilities/delete_elements' })).error,
    ).toBeDefined()
    const actions = (await ro.call('list_canvas_actions')).json().map((entry: Json) => entry.action)
    expect(actions).toContain('get_asset')
    expect(actions).not.toContain('create_library_item')
    expect((await ro.call('list_canvas_actions', { action: 'create_library_item' })).isError).toBe(
      true,
    )
  })

  it('具名发现、工具资源与实际调用发布同一份外部输入契约', async () => {
    const c = client((await issue()).token)
    const tools = (await c.rpc('tools/list')).result.tools as Array<{
      name: string
      inputSchema: Json
    }>
    for (const { name, inputSchema: input } of tools) {
      const named = (await c.call('list_canvas_capabilities', { name })).json()
      const resource = (await c.rpc('resources/read', { uri: 'plein://capabilities/' + name }))
        .result
      expect(named.input_schema, name).toEqual(input)
      expect(JSON.parse(resource.contents[0].text), name).toEqual(named)
      if (name === 'run_node') {
        expect(input.required).toEqual(['id'])
        expect(input.properties.wait_seconds.default).toBe(20)
        expect(Object.keys(input.properties)).toEqual(
          expect.arrayContaining(['canvas_id', 'confirm', 'client_request_id']),
        )
      }
    }
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
    const typo = await c.call('find_elements', { keyword: 'not a supported filter' })
    expect(typo.sc?.error).toMatchObject({ code: 'invalid_params', issues: [{ path: 'keyword' }] })
    const extra = await c.call('perform_canvas_action', {
      action: 'get_media_caps',
      input: { codec: 'h264' },
    })
    expect(extra.sc?.error.code).toBe('invalid_params')
    expect(extra.text).toContain('input.codec')
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

  it('重试会归一化 JSON 键顺序和领域默认值，保留有意义的参数差异', async () => {
    const c = client((await issue(['edit'])).token)
    const action = 'create_library_item'
    const client_request_id = 'repeat-library-item'
    const input = { kind: 'character', name: '重试验收' }
    const first = await c.call('perform_canvas_action', { action, input, client_request_id })
    expect(first.isError).toBe(false)
    const replay = await c.call('perform_canvas_action', {
      client_request_id,
      action,
      input: { name: input.name, voice: null, description: '', images: [], kind: input.kind },
    })
    expect(replay.sc?.replayed).toBe(true)
    expect(replay.json().id).toBe(first.json().id)
    const changed = await c.call('perform_canvas_action', {
      action,
      client_request_id,
      input: { ...input, description: '已更改' },
    })
    expect(changed.sc?.error.code).toBe('invalid_params')
  })

  it('工作区变更重试沿用原回执，即使用户切换到新画布', async () => {
    const c = client((await issue(['edit'])).token)
    const args = { title: '切换画布后重试', client_request_id: 'retry-project' }
    const perform = () => c.rpc('tools/call', { name: 'create_project', arguments: args })
    const first = (await perform()).result
    const created = JSON.parse(first.content[0].text)
    const awareness = running.server.rooms.get(created.canvas_id).awareness
    awareness.setLocalState({
      view: { at: Date.now(), selection: [], viewport: { x: 0, y: 0, w: 640, h: 480 } },
    })
    try {
      const retry = (await perform()).result
      expect(retry.structuredContent.replayed).toBe(true)
      expect(JSON.parse(retry.content[0].text)).toEqual(created)
    } finally {
      awareness.setLocalState(null)
    }
  })

  it('两枚不同归属的令牌各自读取自己的资源、活跃视图和当前画布', async () => {
    const dataDir = tempDir()
    const tokens = new TokenStore(join(dataDir, 'external-mcp.json'))
    const owners = ['fixture-a', 'fixture-b']
    const issued = owners.map((owner) =>
      tokens.issue(owner, { name: owner, scopes: ['read', 'edit'] }),
    )
    const instance = await bootServer({ dataDir })
    const canvases = owners.map((owner, index) => {
      const { db, rooms } = instance.server
      const project = insertProject(db, owner, owner)
      const active = insertCanvas(db, owner, project, '当前画布')
      insertCanvas(db, owner, project, '最近修改但未打开的画布')
      rooms.get(active).awareness.setLocalState({
        view: {
          at: Date.now() + index,
          selection: [],
          viewport: { x: index, y: 0, w: 640, h: 480 },
        },
      })
      return active
    })
    for (const [index, token] of issued.entries()) {
      const c = client(token.token, instance)
      const resources = (await c.rpc('resources/list')).result.resources as Json[]
      const uri = 'plein://canvas/' + canvases[index]
      expect(resources).toHaveLength(2)
      expect(resources.map((r) => r.uri)).toContain(uri)
      const resource = (await c.rpc('resources/read', { uri })).result
      expect(JSON.parse(resource.contents[0].text)).toMatchObject({ section: 'elements' })
      const make = (
        await c.rpc('tools/call', {
          name: 'create_element',
          arguments: { kind: 'markdown', text: owners[index] },
        })
      ).result
      const id = JSON.parse(make.content[0].text).id
      expect(instance.server.rooms.withDoc(canvases[index]!, (doc) => doc.get(id)?.text)).toBe(
        owners[index],
      )
      const undo = (
        await c.rpc('tools/call', {
          name: 'undo_call',
          arguments: { token: make.structuredContent.undo_token },
        })
      ).result
      expect(undo.content[0].text).toBe('已撤销')
    }
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

  it('超长元素的工具与资源返回可编程处理的超限回执，分页能取得原文', async () => {
    const c = client((await issue()).token)
    const made = await c.call('create_element', { kind: 'markdown', text: 'x'.repeat(60_000) })
    const id = made.json().id as string
    const big = await c.call('get_element', { id })
    expect(big.isError).toBe(true)
    expect(big.sc?.error).toMatchObject({ code: 'too_large', limit: 32768 })
    expect(big.text).toContain('get_element_field')
    const result = await c.rpc('resources/read', {
      uri: `plein://canvas/${canvasId}/element/${id}`,
    })
    expect(result.error?.data).toMatchObject({
      code: 'too_large',
      next: { name: 'get_element_field', arguments: { canvas_id: canvasId, id } },
    })
    const page = (
      await c.call('get_element_field', { id, field_path: '/text', text_limit: 8 })
    ).json()
    expect(page).toMatchObject({ value: 'xxxxxxxx', complete: false, next_text_offset: 8 })
  })

  it('已执行的长写入回执可用同一枚令牌取回，重试复用回执', async () => {
    const issued = await issue(['edit'])
    const c = client(issued.token)
    const expressions = Array.from({ length: 16 }, (_, i) => ({
      id: String(i),
      name: '表情' + i,
      description: '表情🌻'.repeat(200),
    }))
    const args = {
      action: 'create_library_item',
      input: { kind: 'character', name: '分页回执验收', profile: { expressions } },
      client_request_id: 'large-library-receipt',
    }
    const first = await c.call('perform_canvas_action', args)
    expect(first.isError).toBe(false)
    expect(first.sc).toMatchObject({ result_omitted: true, code: 'too_large' })
    const uri = first.sc!.recovery.uri as string
    const replay = await c.call('perform_canvas_action', args)
    expect(replay.sc).toMatchObject({ replayed: true, recovery: { uri } })
    const other = client((await issue()).token)
    expect((await other.rpc('resources/read', { uri })).error?.data?.code).toBe('not_found')
    let pageUri: string | undefined = uri
    let joined = ''
    while (pageUri) {
      const resource = (await c.rpc('resources/read', { uri: pageUri })).result.contents[0]
      const page = JSON.parse(resource.text)
      expect(page.offset).toBe(Buffer.byteLength(joined))
      joined += page.text
      pageUri = page.next_uri
    }
    const item = JSON.parse(joined)
    expect(item.name).toBe('分页回执验收')
    expect(item.profile.expressions).toMatchObject(expressions)
  })

  it('ui 动作：没有标签页时给准确提示，有标签页时经 awareness 推送；ui_select 可清空', async () => {
    const c = client((await issue()).token)
    const awareness = running.server.rooms.get(canvasId).awareness
    awareness.setLocalState(null)
    const absent = (await c.call('ui_get_selection')).json()
    expect(absent).toMatchObject({ status: 'no_viewer', source: 'unavailable' })
    expect(absent.total).toBeUndefined()
    expect((await c.call('ui_select', { ids: [] })).text).toContain('没有在浏览器')
    expect((await c.call('ui_set_viewport', { x: 10, y: 20, zoom: 2 })).text).toContain(
      '没有在浏览器',
    )
    awareness.setLocalState({
      view: { selection: [], viewport: { x: 0, y: 0, w: 800, h: 600 }, at: Date.now() },
    })
    expect((await c.call('ui_get_selection')).json()).toMatchObject({ source: 'view', total: 0 })
    expect((await c.call('ui_select', { ids: [] })).text).toBe('已向打开的画布发送视图操作')
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

it('改写预览经模型运行权限和确认，只有另有编辑权限才能写回', async () => {
  const server = running.server
  const id = server.rooms.withDoc(canvasId, (doc) =>
    addNode(doc, 'plein/image', { params: { prompt: '晨光' } }),
  )
  const prompt = () => server.rooms.withDoc(canvasId, (doc) => doc.get(id)?.params?.prompt)
  const reader = client((await issue(['read'])).token)
  const names = (await reader.rpc('tools/list')).result.tools.map(
    (tool: { name: string }) => tool.name,
  )
  expect(names).not.toContain('rewrite_prompt')
  const runner = client((await issue(['run'], { dailyRunLimit: 1 })).token)
  const ask = await runner.call('rewrite_prompt', { id, apply: false })
  expect(ask.json()).toMatchObject({
    status: 'needs_approval',
    reason: expect.stringContaining('对话模型'),
  })
  const denied = await runner.call('rewrite_prompt', { id, apply: true, confirm: true })
  expect(denied.sc?.error.code).toBe('forbidden_scope')
  const preview = await runner.call('rewrite_prompt', { id, apply: false, confirm: true })
  expect(preview.json()).toMatchObject({
    applied: false,
    prompt: expect.stringContaining('【mock】'),
  })
  expect(prompt()).toBe('晨光')
  expect(
    (await runner.call('rewrite_prompt', { id, apply: false, confirm: true })).sc?.error.code,
  ).toBe('rate_limited')
  const editor = client((await issue(['run', 'edit'])).token)
  expect((await editor.call('rewrite_prompt', { id, confirm: true })).isError).toBe(false)
  expect(prompt()).toContain('【mock】')
})

it.each(['submitted', 'unknown'] as const)(
  '改写执行结果 %s 时同一请求只产生一次调用并保留日额度',
  async (outcome) => {
    const { server } = running
    const id = server.rooms.withDoc(canvasId, (doc) =>
      addNode(doc, 'plein/image', { params: { prompt: '保留【角色】' } }),
    )
    const caller = client((await issue(['run'], { dailyRunLimit: 1 })).token)
    const provider = vi.spyOn(server.plugins, 'call')
    try {
      if (outcome === 'submitted')
        provider.mockResolvedValueOnce({
          outputs: [{ type: 'text', text: '丢失的标记' }],
          assets: [],
        })
      else
        provider.mockRejectedValueOnce(
          new ProviderError('unknown', '提交后断线', { outcome: 'unknown' }),
        )
      const args = { id, apply: false, confirm: true, client_request_id: 'rewrite' }
      const first = await caller.call('rewrite_prompt', args)
      expect(first.isError).toBe(true)
      expect(first.sc?.error).toMatchObject({ execution_outcome: outcome })
      expect((await caller.call('rewrite_prompt', args)).sc).toMatchObject({
        replayed: true,
        error: first.sc?.error,
      })
      expect(
        (await caller.call('rewrite_prompt', { ...args, client_request_id: 'new' })).sc?.error.code,
      ).toBe('rate_limited')
      expect(provider).toHaveBeenCalledTimes(1)
    } finally {
      provider.mockRestore()
    }
  },
)

it('字幕识别的未知提交保留原始恢复凭据，重放不再次调用平台', async () => {
  const { server } = running
  const assets = await server.plugins.call(
    'audio.speech',
    mockModel('audio.speech'),
    { text: '回执场景' },
    { ownerId: 'local' },
  )
  const assetId = assets.assets[0]!.assetId
  const model = mockModel('audio.transcribe')
  const entry = server.plugins.registry.providers.get('plein/mock')!
  const original = entry.def
  entry.def = { ...original, lookup: undefined, idempotent: false }
  const submit = vi
    .spyOn(entry.def, 'submit')
    .mockRejectedValueOnce(new ProviderError('unknown', '提交后断线', { outcome: 'unknown' }))
  try {
    const caller = client((await issue(['run'], { dailyRunLimit: 1 })).token)
    const args = {
      action: 'recognize_subtitles',
      input: { assetIds: [assetId], model },
      confirm: true,
      client_request_id: 'subtitles',
    }
    const first = await caller.call('perform_canvas_action', args)
    expect(first.sc?.error).toMatchObject({
      execution_outcome: 'unknown',
      asset_id: assetId,
      model,
      recovery: {
        assetId,
        model,
        expected: expect.any(String),
        recovery: { state: 'submit_unknown' },
      },
    })
    expect((await caller.call('perform_canvas_action', args)).sc).toMatchObject({
      replayed: true,
      error: first.sc?.error,
    })
    expect(
      (await caller.call('perform_canvas_action', { ...args, client_request_id: 'new' })).sc?.error
        .code,
    ).toBe('rate_limited')
    expect(submit).toHaveBeenCalledTimes(1)
  } finally {
    submit.mockRestore()
    entry.def = original
  }
})
