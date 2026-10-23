import { Readable } from 'node:stream'
import { referenceAssets } from '@plein/capabilities'
import { createElement, type PleinDoc, updateElement } from '@plein/doc'
import sharp from 'sharp'
import type { AgentEvent, Canvas } from '@plein/protocol'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { hasFfmpeg } from '../assets/media'
import { startTestServer } from '../testing'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { callTool, McpServer } from './mcp'
import { AgentPlan, type PlanItem } from './plan'
import { agentTools, canvasTools } from './tools'

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
  const { rooms, runs, plugins, assets, library } = running.server
  mcp = new McpServer(
    { name: 'plein', version: 'test' },
    canvasTools({ canvasId, ownerId: 'local', rooms, runs, host: plugins, assets, library }),
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

  it('取帧续镜：取尾帧接出图生视频节点，记下父视频并沿用设置', async () => {
    const parent = (
      await call('create_node', {
        type: 'plein/video',
        params: { prompt: '她走到窗边', duration: 8, aspectRatio: '9:16' },
      })
    ).json()
    // 还没出视频时说清楚
    expect((await call('continue_shot', { element_id: parent.id })).text).toContain('没有视频')
    const run = (await call('run_node', { id: parent.id, wait_seconds: 20 })).json()
    expect(run.status).toBe('succeeded')

    const next = await call('continue_shot', { element_id: parent.id, prompt: '她回头' })
    // 取帧要本机 ffmpeg（CI 的单元测试机没装）：没有时把原因说清楚
    if (!(await hasFfmpeg())) {
      expect(next.text).toContain('ffmpeg')
      return
    }
    expect(next.error).toBe(false)
    const made = next.json()
    expect(made.frame_element_id).toBeTruthy()
    expect(made.continues_from).toMatchObject({ elementId: parent.id, last: true })
    const el = (await call('get_element', { id: made.id })).json()
    expect(el.params).toMatchObject({
      mode: 'image',
      prompt: '她回头',
      duration: 8,
      aspectRatio: '9:16',
    })
    expect(el.params.continuesFrom.frameAssetId).toBeTruthy()
    const canvas = (await call('get_canvas')).json()
    expect(canvas.edges).toContainEqual(
      expect.stringContaining(`${made.frame_element_id}.image → ${made.id}.images`),
    )
  })

  it('局部重绘：原图 + 同尺寸蒙版交给原生蒙版模型；没画区域或原图换了时说清楚', async () => {
    const image = (
      await call('create_node', { type: 'plein/image', params: { prompt: '书桌' } })
    ).json()
    const ran = (await call('run_node', { id: image.id, wait_seconds: 20 })).json()
    expect(ran.status).toBe('succeeded')
    const source = ran.results[0].asset_id as string
    const meta = running.server.assets.get('local', source)!
    const png = await sharp({
      create: { width: meta.width!, height: meta.height!, channels: 3, background: '#000' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 10, height: 10, channels: 3, background: '#fff' },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer()
    const mask = await running.server.assets.ingest('local', Readable.from([png]), {
      mime: 'image/png',
      name: 'mask.png',
    })

    const edit = (
      await call('create_node', {
        type: 'plein/image-edit',
        params: { prompt: '换成红色台灯' },
        inputs: [{ from: image.id, to_port: 'image' }],
      })
    ).json()
    const missing = (await call('run_node', { id: edit.id, wait_seconds: 20 })).json()
    expect(missing.status).toBe('failed')
    expect(JSON.stringify(missing)).toContain('还没画重绘区域')

    const params = { mask: { assetId: mask.id, width: meta.width, height: meta.height } }
    await call('update_element', {
      id: edit.id,
      params: { ...params, mask: { ...params.mask, sourceAssetId: 'other' } },
    })
    const stale = (await call('run_node', { id: edit.id, wait_seconds: 20 })).json()
    expect(JSON.stringify(stale)).toContain('原图换过了')

    await call('update_element', {
      id: edit.id,
      params: { mask: { ...params.mask, sourceAssetId: source } },
    })
    const done = (await call('run_node', { id: edit.id, wait_seconds: 20 })).json()
    expect(done.status).toBe('succeeded')
    const out = running.server.assets.get('local', done.results[0].asset_id)!
    // 结果按原图尺寸出
    expect([out.width, out.height]).toEqual([meta.width, meta.height])
  })

  it('镜头与风格预设：拼进提示词末尾，只改自己那两行', async () => {
    const v = (
      await call('create_node', { type: 'plein/video', params: { prompt: '她回头' } })
    ).json()
    const options = (await call('apply_shot_presets', { id: v.id })).json().options
    expect(options['camera.move']).toContainEqual(expect.stringContaining('plein/cam-push'))
    const made = (
      await call('apply_shot_presets', {
        id: v.id,
        move: 'plein/cam-orbit',
        speed: 'slow',
        style: 'plein/style-film',
      })
    ).json()
    expect(made.prompt).toBe('她回头\n镜头：缓慢环绕主体。\n风格：胶片质感，细腻颗粒，暖色调。')
    const cleared = (await call('apply_shot_presets', { id: v.id, move: null })).json()
    expect(cleared.prompt).toBe('她回头\n风格：胶片质感，细腻颗粒，暖色调。')
    expect(
      (await call('apply_shot_presets', { id: v.id, move: 'plein/style-film' })).text,
    ).toContain('不是这个节点')
  })

  it('分镜组：编号、调顺序、排版、拼成大图并如实给出像素', async () => {
    const png = (color: string) =>
      sharp({ create: { width: 64, height: 36, channels: 3, background: color } })
        .png()
        .toBuffer()
    const assets = await Promise.all(
      ['#f00', '#0f0', '#00f'].map(async (c, i) =>
        running.server.assets.ingest('local', Readable.from([await png(c)]), {
          mime: 'image/png',
          name: `镜头${i + 1}.png`,
        }),
      ),
    )
    const ids: string[] = []
    for (const [i, a] of assets.entries())
      ids.push(
        (await call('create_element', { kind: 'image', asset_id: a.id, x: i * 200, y: 0 })).json()
          .id,
      )
    const { frame_id } = (await call('group_elements', { ids, name: '第一场' })).json()
    const made = (
      await call('shot_group', { frame_id, order: [ids[2]], arrange: true, cols: 2 })
    ).json()
    expect(made.shots.map((s: { id: string }) => s.id)).toEqual([ids[2], ids[0], ids[1]])
    expect(made.cols).toBe(2)

    const collage = await call('make_collage', { frame_id, numbers: false })
    expect(collage.error).toBe(false)
    const out = collage.json()
    // 每格 64×36，两列两行，四周和格间 16px 留白
    expect(out).toMatchObject({ cols: 2, rows: 2, width: 64 * 2 + 16 * 3, height: 36 * 2 + 16 * 3 })
    const el = (await call('get_element', { id: out.id })).json()
    expect(el.name).toContain(`${out.width}×${out.height}`)

    expect((await call('shot_group', { frame_id, clear: true })).json().shot_group).toBe(false)
    expect((await call('make_collage', { frame_id: ids[0] })).text).toContain('不是 Frame')
  })

  it('剧情与提示词能力：铺短剧模板、套预设、改写提示词', async () => {
    const drama = await call('place_drama_template')
    expect(drama.error).toBe(false)
    expect(drama.json().frames.length).toBeGreaterThan(0)
    const board = (await call('find_elements', { query: '分镜' })).json()
    expect(board.total).toBeGreaterThan(0)

    const image = (await call('create_node', { type: 'plein/image' })).json()
    const presets = (await call('list_presets', { id: image.id })).json() as Array<{ id: string }>
    expect(presets.length).toBeGreaterThan(0)
    const applied = await call('apply_preset', { id: image.id, preset_id: presets[0]!.id })
    expect(applied.error).toBe(false)
    expect(applied.json().prompt).toBeTruthy()

    const rewritten = await call('rewrite_prompt', { id: image.id, mode: 'optimize' })
    expect(rewritten.error).toBe(false)
    const el = (await call('get_element', { id: image.id })).json()
    expect(el.params.prompt).toContain('【mock】')
    // 没有展开结果的节点不能生成设定卡，原因说清楚
    expect((await call('extract_cast', { id: image.id })).text).toContain('抽取结果')
  })

  it('资产库：搜索、用到画布上、存回去', async () => {
    const lib = running.server.library
    const photo = await running.server.assets.ingest(
      'local',
      Readable.from([
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#67a' } })
          .png()
          .toBuffer(),
      ]),
      { name: '角色参考.png', mime: 'image/png' },
    )
    const made = lib.create('local', {
      kind: 'character',
      name: '林夏',
      projectId: null,
      description: '短发，白衬衫',
      tags: {},
      voice: null,
      images: [
        { slot: 'main', assetId: photo.id },
        { slot: 'half', assetId: photo.id },
        { slot: 'head_3view', assetId: photo.id },
      ],
      video: null,
      models: [],
      profile: null,
    })
    const found = (await call('search_library', { query: '白衬衫' })).json()
    expect(found.items.map((i: { id: string }) => i.id)).toContain(made.id)
    const placed = (await call('place_library_item', { item_id: made.id })).json()
    expect(placed.existed).toBe(false)
    expect(placed.skipped_assets).toBeUndefined()
    expect(
      running.server.rooms.withDoc(canvasId, (doc) =>
        referenceAssets(doc, doc.get(placed.id)!, 'image'),
      ),
    ).toEqual([photo.id])
    expect((await call('place_library_item', { item_id: made.id })).json()).toMatchObject({
      id: placed.id,
      existed: true,
    })
    await call('update_element', { id: placed.id, params: { description: '短发，红裙子' } })
    const saved = (await call('save_to_library', { id: placed.id })).json()
    expect(saved).toEqual({ item_id: made.id, created: false })
    expect(lib.get('local', made.id)?.description).toBe('短发，红裙子')
    expect(lib.get('local', made.id)?.images).toEqual(made.images)
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
    const changes = new AgentChanges('agt_test', id, 'local', rooms, runs, (ids) =>
      touched.push(ids),
    )
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

describe('确认关卡与界面能力', () => {
  async function setup(mode: 'rules' | 'always' | 'auto' = 'rules') {
    const res = await fetch(`${running.url}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const id = ((await res.json()) as Canvas).id
    const { rooms, runs, plugins, assets } = running.server
    const changes = new AgentChanges('agt_gate', id, 'local', rooms, runs)
    const decided: string[] = []
    const approvals = new Approvals((a) => decided.push(`${a.tool}:${a.status}`))
    const ui: Array<[string, string[]]> = []
    const server = new McpServer(
      { name: 'plein', version: 'test' },
      agentTools(
        {
          canvasId: id,
          ownerId: 'local',
          rooms,
          runs,
          host: plugins,
          assets,
          origin: changes.origin,
          onRun: (n, r) => changes.recordRun(n, r),
          onGroup: (g) => changes.recordGroup(g),
          ui: (action, ids) => {
            ui.push([action, ids])
            return true
          },
        },
        { changes, approvals, mode: () => mode },
      ),
    )
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await server.handle({
        jsonrpc: '2.0',
        id: ++seq,
        method: 'tools/call',
        params: { name, arguments: args },
      })) as { result: { content: Array<{ text?: string }>; isError?: boolean } }
      const text = r.result.content[0]?.text ?? ''
      return { error: r.result.isError === true, text, json: () => JSON.parse(text) }
    }
    changes.begin('t1')
    return { id, rooms, changes, approvals, decided, ui, call }
  }

  it('不兼容的分辨率在审批前返回问题，修正后才请求批准', async () => {
    const { call, approvals, decided, changes } = await setup()
    const video = (
      await call('create_node', {
        type: 'plein/video',
        params: { model: 'minimax/api:MiniMax-H3', prompt: '水杯特写', resolution: '1080p' },
      })
    ).json()
    const blocked = await call('run_node', { id: video.id, wait_seconds: 0 })
    expect(blocked.error).toBe(true)
    expect(blocked.text).toContain('768P、2K')
    expect(decided).toEqual([])
    await call('update_element', { id: video.id, params: { resolution: '2K' } })
    const gated = (await call('run_node', { id: video.id, wait_seconds: 0 })).json()
    expect(gated.status).toBe('needs_approval')
    expect(decided).toEqual(['run_node:pending'])
    // 真实平台能力校验；不批准、不提交外部生成。
    approvals.decide(gated.approval_id, false)
    changes.release()
  })

  it('视频生成要确认，允许后直接执行并由 await_approval 返回结果', async () => {
    const { call, approvals, changes } = await setup()
    const text = (
      await call('create_node', { type: 'plein/text', params: { text: '雨夜' } })
    ).json()
    const image = (
      await call('create_node', { type: 'plein/image', inputs: [{ from: text.id }] })
    ).json()
    // 图片直接跑
    expect((await call('run_node', { id: image.id, wait_seconds: 10 })).json().status).toBe(
      'succeeded',
    )
    const video = (
      await call('create_node', {
        type: 'plein/video',
        params: { prompt: '镜头缓缓推进' },
        inputs: [{ from: image.id }],
      })
    ).json()
    const gated = (await call('run_node', { id: video.id, wait_seconds: 10 })).json()
    expect(gated.status).toBe('needs_approval')
    expect(gated.reason).toContain('视频')
    expect(
      (await call('await_approval', { approval_id: gated.approval_id, wait_seconds: 0 })).json(),
    ).toEqual({ status: 'pending' })
    expect(approvals.decide(gated.approval_id, true)).toBe(true)
    const done = (await call('await_approval', { approval_id: gated.approval_id })).json()
    expect(done.error).toBeUndefined()
    expect(done.status).toBe('succeeded')
    expect(changes.end()!.runs).toBe(2)
    changes.release()
  })

  it('跳过的操作不执行；删本轮自己建的不问，删用户已有的要问', async () => {
    const { call, approvals, rooms, id, changes } = await setup()
    const mine = rooms.withDoc(id, (d) =>
      createElement(d, { kind: 'markdown', x: 0, y: 0, w: 100, h: 100 }),
    )
    const made = (await call('create_element', { kind: 'markdown', text: 'AI' })).json()
    expect((await call('delete_elements', { ids: [made.id] })).text).toContain('已删除')
    const gated = (await call('delete_elements', { ids: [mine] })).json()
    expect(gated.status).toBe('needs_approval')
    approvals.decide(gated.approval_id, false)
    expect((await call('await_approval', { approval_id: gated.approval_id })).text).toContain(
      '跳过',
    )
    rooms.withDoc(id, (d) => expect(d.get(mine)).toBeDefined())
    changes.end()
    changes.release()
  })

  it('整组运行要确认；auto 模式不问；一轮结束时没确认的作废', async () => {
    const gate = await setup()
    const frame = (await gate.call('create_element', { kind: 'frame' })).json()
    const gated = (await gate.call('run_frame', { frame_id: frame.id })).json()
    expect(gated.status).toBe('needs_approval')
    gate.approvals.expireAll()
    expect(gate.decided).toContain('run_frame:expired')
    expect(gate.approvals.decide(gated.approval_id, true)).toBe(false)
    // 分镜批量运行同样要确认
    const board = (await gate.call('create_node', { type: 'plein/storyboard' })).json()
    const batch = (await gate.call('run_storyboard', { id: board.id, role: 'image' })).json()
    expect(batch.status).toBe('needs_approval')
    gate.changes.end()
    gate.changes.release()

    const auto = await setup('auto')
    const f2 = (await auto.call('create_element', { kind: 'frame' })).json()
    await auto.call('create_node', { type: 'plein/text', params: { text: 'x' }, parent_id: f2.id })
    const started = (await auto.call('run_frame', { frame_id: f2.id })).json()
    expect(started.group_id).toBeTruthy()
    const state = (await auto.call('wait_for_group', { group_id: started.group_id })).json()
    expect(state.status).toBe('done')
    auto.changes.end()
    auto.changes.release()
  })

  it('选区绑定本轮发送快照，视口实时读取，并能把镜头带到元素上', async () => {
    const { call, rooms, id, ui, changes } = await setup()
    expect((await call('ui_get_selection')).json()).toMatchObject({ total: 0, elements: [] })
    const el = (
      await call('create_element', { kind: 'markdown', text: '选中的', x: 10, y: 10 })
    ).json()
    rooms.get(id).awareness.setLocalState({
      view: { selection: [el.id], viewport: { x: 0, y: 0, w: 1000, h: 800 }, at: Date.now() },
    })
    // 没有附带目标的这一轮，不因画布上的新选区偷偷带入目标。
    expect((await call('ui_get_selection')).json()).toMatchObject({ total: 0, elements: [] })
    const { runs, plugins, assets } = running.server
    const snapshot = canvasTools({
      canvasId: id,
      ownerId: 'local',
      rooms,
      runs,
      host: plugins,
      assets,
      selection: [el.id],
    }).find((tool) => tool.name === 'ui_get_selection')!
    rooms.get(id).awareness.setLocalState({
      view: { selection: [], viewport: { x: 0, y: 0, w: 1000, h: 800 }, at: Date.now() },
    })
    const selected = await callTool(snapshot, {})
    const selectedText = selected.content.find((block) => block.type === 'text')!
    expect(selectedText.type === 'text' && JSON.parse(selectedText.text)).toMatchObject({
      total: 1,
      elements: [{ id: el.id }],
    })
    const view = (await call('ui_get_viewport')).json()
    expect(view.elements.map((e: { id: string }) => e.id)).toContain(el.id)
    expect((await call('ui_focus', { ids: [el.id, 'nope'] })).text).toContain('已在用户屏幕上')
    expect(ui).toEqual([['focus', [el.id]]])
    rooms.get(id).awareness.setLocalState(null)
    changes.end()
    changes.release()
  })
})

describe('内置智能体', () => {
  it('不装 CLI，用支持工具调用的对话模型跑完一轮：看画布、建节点、运行、回复，文字流式推送', async () => {
    const { agents } = running.server
    const status = await agents.status()
    const builtin = status.agents.find((a) => a.id === 'builtin')
    expect(builtin).toMatchObject({ available: true, model: 'Mock 智能体' })

    const res = await fetch(`${running.url}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const id = ((await res.json()) as Canvas).id
    const session = agents.create(id, 'local', 'builtin')
    const events: AgentEvent[] = []
    const idle = new Promise<void>((resolve) => {
      agents.subscribe(session.id, (e) => {
        events.push(e)
        if (e.type === 'status' && e.status === 'idle') resolve()
      })
    })
    await agents.send(session.id, 'local', '画一张雨夜天台')
    await idle

    const items = agents.get(session.id, 'local')!.items
    const tools = items.flatMap((i) => (i.type === 'tool' ? [`${i.name}:${i.status}`] : []))
    expect(tools).toEqual(['get_canvas:done', 'create_node:done', 'run_node:done', 'ui_focus:done'])
    const reply = items.find((i) => i.type === 'text')
    expect(reply?.type === 'text' && reply.text).toContain('【mock】好了')
    const changes = items.find((i) => i.type === 'changes')
    expect(changes).toMatchObject({ created: [expect.any(String)], runs: 1, undoable: true })
    // 回复是一段段推过来的，最后一次是全文
    const partial = events.filter(
      (e) => e.type === 'item' && e.item.type === 'text' && e.item.id === reply?.id,
    )
    expect(partial.length).toBeGreaterThan(2)

    // 第二轮带上前一轮的对话；新一轮没提画图，只看画布
    const idle2 = new Promise<void>((resolve) => {
      agents.subscribe(session.id, (e) => {
        if (e.type === 'status' && e.status === 'idle') resolve()
      })
    })
    await agents.send(session.id, 'local', '现在有哪些元素')
    await idle2
    const last = agents.get(session.id, 'local')!.items.at(-1)
    expect(last?.type === 'text' && last.text).toContain('看过画布了')
  })

  it('计划模式：先出计划，用户同意后才动手，边做边打勾', async () => {
    const { agents } = running.server
    const res = await fetch(`${running.url}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const id = ((await res.json()) as Canvas).id
    const session = agents.create(id, 'local', 'builtin')
    const idle = new Promise<void>((resolve) => {
      agents.subscribe(session.id, (e) => {
        if (e.type === 'item' && e.item.type === 'plan' && e.item.status === 'pending')
          agents.decide(session.id, 'local', e.item.id, true)
        if (e.type === 'status' && e.status === 'idle') resolve()
      })
    })
    await agents.send(session.id, 'local', '画一张雨夜天台', undefined, 'rules', true)
    await idle

    const items = agents.get(session.id, 'local')!.items
    const plan = items.find((i): i is PlanItem => i.type === 'plan')
    expect(plan).toMatchObject({
      status: 'approved',
      steps: [
        { title: '新建生成图片节点', status: 'done' },
        { title: '运行出图', status: 'done' },
      ],
    })
    // 计划卡片代替确认卡片
    expect(items.some((i) => i.type === 'approval')).toBe(false)
    const tools = items.flatMap((i) => (i.type === 'tool' ? [i.name] : []))
    expect(tools.slice(0, 4)).toEqual([
      'get_canvas',
      'propose_plan',
      'await_approval',
      'update_plan',
    ])
    expect(tools).toContain('create_node')
  })
})

describe('计划关卡', () => {
  it('计划被同意前不能改画布，同意后放行，只能更新已同意的计划', async () => {
    const res = await fetch(`${running.url}/api/canvases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const id = ((await res.json()) as Canvas).id
    const { rooms, runs, plugins, assets } = running.server
    const changes = new AgentChanges('agt_plan', id, 'local', rooms, runs)
    const seen: PlanItem[] = []
    const plan = new AgentPlan((item) => seen.push(item))
    const approvals = new Approvals((a) => plan.onApproval(a))
    const server = new McpServer(
      { name: 'plein', version: 'test' },
      agentTools(
        { canvasId: id, ownerId: 'local', rooms, runs, host: plugins, assets },
        { changes, approvals, mode: () => 'auto', plan },
      ),
    )
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await server.handle({
        jsonrpc: '2.0',
        id: ++seq,
        method: 'tools/call',
        params: { name, arguments: args },
      })) as { result: { content: Array<{ text?: string }>; isError?: boolean } }
      return { error: r.result.isError === true, text: r.result.content[0]?.text ?? '' }
    }
    changes.begin('t1')
    plan.begin(true)

    expect((await call('get_canvas')).error).toBe(false)
    const early = await call('create_element', { kind: 'markdown', text: 'x' })
    expect(early).toMatchObject({ error: true, text: expect.stringContaining('计划模式') })
    expect((await call('update_plan', { step: 1, status: 'done' })).error).toBe(true)

    const proposed = JSON.parse((await call('propose_plan', { steps: ['写笔记'] })).text)
    expect(proposed.status).toBe('needs_approval')
    const waiting = await call('create_element', { kind: 'markdown', text: 'x' })
    expect(waiting.text).toContain('等用户同意')

    approvals.decide(proposed.approval_id, true)
    expect((await call('create_element', { kind: 'markdown', text: 'x' })).error).toBe(false)
    expect((await call('update_plan', { step: 1, status: 'done' })).text).toContain('都完成了')
    expect(seen.at(-1)).toMatchObject({ status: 'approved', steps: [{ status: 'done' }] })
    changes.release()
  })
})
