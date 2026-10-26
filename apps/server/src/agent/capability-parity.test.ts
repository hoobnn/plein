import { definePlugin, defineServerPlugin, PLUGIN_API_VERSION } from '@plein/plugin-sdk'
import { emptyProductionGoal, productionGoalHeads } from '@plein/doc'
import { Readable } from 'node:stream'
import { createElement, connect, sequenceInstancesOf, updateElement } from '@plein/doc'
import { describe, expect, it } from 'vite-plus/test'
import sharp from 'sharp'
import { addNode, bootServer, createCanvas } from '../testing'
import { agentTools, canvasTools, serverContext, serverCapabilities, type ToolEnv } from './tools'
import { callTool, inputSchema } from './mcp'
import { requestWithinBudget } from './context-budget'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import type { AssetStore } from '../assets/store'

async function fixture() {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    library: server.library,
    mediaIndex: server.mediaIndex,
    checkpoints: server.checkpoints,
    canvasApi: server.canvasApi,
  }
  const invoke = (name: string, args: unknown) =>
    serverCapabilities.invoke(name, serverContext(env), args)
  const action = (action: string, input: Record<string, unknown> = {}) =>
    invoke('perform_canvas_action', { action, input })
  return { server, id, doc, env, invoke, action }
}

describe('画布与 Agent 能力契约', () => {
  it('完整工具目录仍可放入首轮模型请求预算，扩展操作按需读取契约', async () => {
    const f = await fixture()
    const tools = canvasTools(f.env).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: inputSchema(t.input),
    }))
    expect(
      requestWithinBudget(
        [
          { role: 'system', content: '操作画布' },
          { role: 'user', content: '检查当前画布' },
        ],
        tools,
      ),
    ).toBe(true)
    const details = (await f.invoke('list_canvas_actions', { action: 'capture_panorama' })) as {
      input_schema: { properties: unknown }
    }
    expect(details.input_schema.properties).toHaveProperty('request')
    await expect(f.invoke('list_canvas_actions', { action: 'constructor' })).rejects.toThrow(
      '没有画布操作',
    )
    const stage = (await f.invoke('list_node_types', { type: 'plein/stage' })) as Array<{
      params_schema: object
    }>
    expect(stage[0]?.params_schema).toHaveProperty('properties.scene')
  })

  it('扩展操作使用实际用户身份及 UI 路由，不信任 input 里的 owner', async () => {
    const f = await fixture()
    const made = (await f.action('create_library_item', {
      kind: 'scene',
      name: '教室',
      description: '明亮',
      ownerId: 'other',
    })) as { id: string }
    expect(f.server.library.get('local', made.id)?.name).toBe('教室')
    expect(f.server.library.get('other', made.id)).toBeNull()
    await f.action('update_library_item', { id: made.id, patch: { description: '夜景' } })
    expect(f.server.library.get('local', made.id)?.description).toBe('夜景')
    const other = serverContext({ ...f.env, ownerId: 'other' })
    await expect(
      serverCapabilities.invoke('perform_canvas_action', other, {
        action: 'get_library_item',
        input: { id: made.id },
      }),
    ).rejects.toThrow('不存在')
    await expect(f.action('capture_panorama', { id: made.id, request: {} })).rejects.toThrow(
      '参数不对',
    )
  })

  it('扩展付费与删除操作走规则审批，未批准不产生副作用', async () => {
    const f = await fixture()
    const changes = new AgentChanges('parity', f.id, 'local', f.server.rooms, f.server.runs)
    changes.begin('turn')
    let cards = 0
    const approvals = new Approvals((a) => {
      if (a.status === 'pending') cards++
    })
    const tools = agentTools(f.env, { changes, approvals, mode: () => 'rules' })
    try {
      for (const [action, input] of [
        [
          'create_voice',
          { mode: 'register', provider: 'minimax/audio', name: '音色', voiceId: 'existing' },
        ],
        ['delete_library_item', { id: 'missing' }],
      ] as const) {
        const result = await callTool(
          tools.find((t) => t.name === 'perform_canvas_action')!,
          { action, input },
        )
        expect(
          JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}').status,
        ).toBe('needs_approval')
      }
      const invalid = await callTool(
        tools.find((t) => t.name === 'perform_canvas_action')!,
        { action: 'create_voice', input: {} },
      )
      expect(invalid.isError).toBe(true)
      expect(cards).toBe(2)
    } finally {
      approvals.expireAll()
      changes.end()
      changes.release()
    }
  })

  it('序列使用真实素材时长固定实例，支持复制、单次剪辑和并发拒绝', async () => {
    const f = await fixture()
    // 固定命令只读已入库元数据，这里无需生成或探测真实视频。
    const hash = 'a'.repeat(64)
    const video = createElement(f.doc, { kind: 'video', x: 0, y: 0, w: 320, h: 180, assetId: hash })
    const seq = addNode(f.doc, 'plein/sequence')
    connect(f.doc, [video, 'video'], [seq, 'clips'])
    const ctx = { ...serverContext(f.env), assetMeta: () => ({ kind: 'video', duration: 8 }) }
    const run = (name: string, args: unknown) => serverCapabilities.invoke(name, ctx, args)
    const read = () =>
      run('get_sequence', { id: seq }) as Promise<{
        version: string
        clips: Array<{ clipInstanceId: string }>
      }>
    const before = await read()
    expect(before.clips).toHaveLength(1)
    await run('edit_sequence', {
      id: seq,
      action: 'fix',
      clip_id: before.clips[0]!.clipInstanceId,
      sound: 'native',
      expected_version: before.version,
    })
    const fixed = sequenceInstancesOf(f.doc.get(seq)!)[0]!
    expect(fixed.segment?.duration).toBe(8)
    await expect(
      run('edit_sequence', {
        id: seq,
        action: 'remove',
        clip_id: fixed.clipInstanceId,
        expected_version: before.version,
      }),
    ).rejects.toThrow('已变化')
    const now = await read()
    await run('edit_sequence', {
      id: seq,
      action: 'duplicate',
      clip_id: fixed.clipInstanceId,
      sound: 'mix',
      expected_version: now.version,
    })
    const copied = await read()
    await run('edit_sequence', {
      id: seq,
      action: 'edit',
      clip_id: copied.clips[1]!.clipInstanceId,
      patch: { in: 2, out: 4, speed: 2 },
      expected_version: copied.version,
    })
    const clips = sequenceInstancesOf(f.doc.get(seq)!)
    expect(clips[0]!.in).toBe(0)
    expect(clips[1]).toMatchObject({ in: 2, out: 4, speed: 2 })
  })

  it('旧序列命令失败不留下迁移或局部改动', async () => {
    const f = await fixture()
    const video = createElement(f.doc, {
      kind: 'video',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      assetId: 'b'.repeat(64),
    })
    const seq = addNode(f.doc, 'plein/sequence', { params: { instanceVersion: 1 } })
    connect(f.doc, [video, 'video'], [seq, 'clips'])
    const before = f.doc.get(seq)!.params
    const read = (await f.invoke('get_sequence', { id: seq })) as {
      version: string
      clips: Array<{ clipInstanceId: string }>
    }
    await expect(
      f.invoke('edit_sequence', {
        id: seq,
        action: 'duplicate',
        clip_id: read.clips[0]!.clipInstanceId,
        sound: 'native',
        expected_version: read.version,
      }),
    ).rejects.toThrow('无法执行')
    expect(f.doc.get(seq)!.params).toEqual(before)
  })

  it('候选审片不改变采用，旧候选目标不能覆盖新采用', async () => {
    const f = await fixture()
    const hash = 'c'.repeat(64)
    const image = createElement(f.doc, { kind: 'image', x: 0, y: 0, w: 320, h: 180, assetId: hash })
    await f.invoke('review_candidate', {
      id: image,
      asset_id: hash,
      status: 'changes',
      note: '构图需调整',
    })
    expect(f.doc.get(image)!.reviews?.[0]?.note).toBe('构图需调整')
    updateElement(f.doc, image, { assetId: 'd'.repeat(64) })
    await expect(
      f.invoke('review_candidate', { id: image, asset_id: hash, status: 'usable' }),
    ).rejects.toThrow('目标已变化')
  })

  it('元素样式、锁定及清除采用可读写；无效媒体替换不留下其他修改', async () => {
    const f = await fixture()
    const image = createElement(f.doc, {
      kind: 'image',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
      assetId: 'e'.repeat(64),
    })
    await f.invoke('update_element', { id: image, locked: true, rotation: 30, color: '#123456' })
    expect(await f.invoke('get_element', { id: image })).toMatchObject({
      locked: true,
      rotation: 30,
      color: '#123456',
    })
    await expect(
      f.invoke('update_element', { id: image, name: 'wrong', asset_id: 'missing' }),
    ).rejects.toThrow('有效资产')
    expect(f.doc.get(image)!.name).toBeUndefined()
    const node = addNode(f.doc, 'plein/image')
    await f.invoke('adopt_result', { id: node, result_id: null })
    expect(f.doc.get(node)!.adopted).toBeUndefined()
  })

  it('检查点保存和恢复复用正式服务，原画布保留，素材检索隔离用户', async () => {
    const f = await fixture()
    createElement(f.doc, { kind: 'markdown', x: 0, y: 0, w: 320, h: 180, text: '保存原文' })
    const saved = (await f.invoke('create_checkpoint', { name: '开始剪辑前' })) as { id: string }
    const list = (await f.invoke('list_checkpoints', {})) as { items: Array<{ id: string }> }
    expect(list.items.some((x) => x.id === saved.id)).toBe(true)
    const restored = (await f.invoke('restore_checkpoint', { checkpoint_id: saved.id })) as {
      canvasId: string
    }
    expect(restored.canvasId).not.toBe(f.id)
    expect([...f.doc.elements()]).toHaveLength(1)
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    const asset = await f.server.assets.ingest('local', Readable.from([bytes]), {
      name: 'own.png',
      mime: 'image/png',
    })
    await f.server.mediaIndex.rebuild()
    const found = (await f.invoke('search_media', { q: 'own' })) as { items: Array<{ id: string }> }
    expect(found.items.map((x) => x.id)).toContain(asset.id)
  })

  it('制作目标明确署名 agent，旧 head 拒绝覆盖且不会产生人工确认', async () => {
    const f = await fixture()
    const board = addNode(f.doc, 'plein/storyboard')
    const request = {
      id: board,
      operation: {
        action: 'goal',
        expectedHeads: [],
        content: { ...emptyProductionGoal(), requirements: '保留原声' },
      },
    }
    await f.invoke('edit_production', request)
    const heads = productionGoalHeads(f.doc.get(board), { canvasId: f.id, boardId: board })
    expect(heads).toHaveLength(1)
    expect(heads[0]!.actor.source).toBe('agent')
    expect(f.doc.get(board)!.production?.confirmations).toEqual([])
    await expect(f.invoke('edit_production', request)).rejects.toThrow('版本已变化')
  })

  it('插件模板与用户模板均可铺设，引用命令参与本轮撤销', async () => {
    const f = await fixture()
    f.server.plugins.load(
      [
        defineServerPlugin(
          definePlugin({
            manifest: {
              id: 'test/templates',
              name: '模板',
              version: '1.0.0',
              engines: { plein: `^${PLUGIN_API_VERSION}` },
              contributes: { templates: ['test/flow'] },
            },
            templates: [
              {
                id: 'test/flow',
                title: '文本工作流',
                nodes: [{ key: 'text', type: 'plein/text', version: 1, x: 0, y: 0 }],
                edges: [],
              },
            ],
          }),
          {},
        ),
      ],
      false,
    )
    const templates = (await f.invoke('list_canvas_templates', {})) as Array<{ id: string }>
    expect(templates.length).toBeGreaterThan(0)
    const made = (await f.invoke('place_canvas_template', {
      id: templates[0]!.id,
      source: 'plugin',
      x: 10,
      y: 20,
    })) as { ids: string[] }
    expect(made.ids.length).toBeGreaterThan(0)
    const frame = f.doc.get(made.ids[0]!)!
    expect(frame).toMatchObject({ kind: 'frame', x: 10, y: 20 })
    const { referenceClipboard } = await import('@plein/capabilities')
    const data = referenceClipboard.copy(f.doc, made.ids)
    const saved = (await f.action('save_template', { title: '保存的工作流', data })) as {
      id: string
    }
    const changes = new AgentChanges(
      'template-parity',
      f.id,
      'local',
      f.server.rooms,
      f.server.runs,
    )
    changes.begin('turn')
    try {
      const ctx = serverContext({ ...f.env, origin: changes.origin })
      const copy = (await serverCapabilities.invoke('place_canvas_template', ctx, {
        id: saved.id,
        source: 'saved',
      })) as { ids: string[] }
      expect(copy.ids[0]).not.toBe(made.ids[0])
      changes.end()
      expect(changes.undoTurn('turn')).toBe(true)
      expect(f.doc.get(copy.ids[0]!)).toBeUndefined()
      expect(f.doc.get(made.ids[0]!)).toBeDefined()
    } finally {
      changes.release()
    }
  })

  it('客户端渲染请求从 null awareness 状态建立，响应后清理请求并写入图片来源', async () => {
    const f = await fixture()
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'gray' },
    })
      .png()
      .toBuffer()
    const image = await f.server.assets.ingest('local', Readable.from([bytes]), {
      name: 'stage.png',
      mime: 'image/png',
    })
    const awareness = f.server.rooms.get(f.id).awareness
    expect(awareness.getLocalState()).toBeNull()
    awareness.getStates().set(123, { canvasRenderer: 1, view: { at: 1 } })
    const stage = addNode(f.doc, 'plein/stage')
    const pending = f.invoke('capture_stage', { id: stage })
    const requests = awareness.getLocalState()?.canvasRenderRequests as Record<string, unknown>
    const requestId = Object.keys(requests)[0]!
    expect(requests[requestId]).toBeDefined()
    awareness.getStates().set(123, { canvasRenderResults: { [requestId]: { assetId: image.id } } })
    awareness.emit('change', [{ added: [], updated: [123], removed: [] }, null])
    expect(await pending).toMatchObject({ asset_id: image.id })
    expect(awareness.getLocalState()).toBeNull()
    expect(f.doc.get(stage)!.params?.snapshots).toHaveLength(1)
  })

  it('媒体协议新字段均可从工具 schema 发现；无客户端截图明确失败', async () => {
    const f = await fixture()
    const tool = canvasTools(f.env).find((t) => t.name === 'edit_media')!
    const schema = inputSchema(tool.input) as { properties: Record<string, unknown> }
    for (const key of ['replacementAssetId', 'replacementStart', 'keepPitch', 'last'])
      expect(schema.properties).toHaveProperty(key)
    const stage = addNode(f.doc, 'plein/stage')
    await expect(f.invoke('capture_stage', { id: stage })).rejects.toThrow('打开当前画布')
  })

  it('扩展操作的 id 不能带 ../ 或 ? 跳出登记在册的路由', async () => {
    const f = await fixture()
    const made = (await f.action('create_library_item', {
      kind: 'scene',
      name: '教室',
      description: '明亮',
    })) as { id: string }
    expect(f.server.library.get('local', made.id)?.name).toBe('教室')
    // 路径穿越若生效，会读到没登记的资产库、模板、音色列表
    for (const id of [
      '../assets/../library?x',
      '../assets/../templates?x',
      '../assets/../voices?x',
      '../assets/../assets?x',
    ])
      await expect(f.action('get_asset', { id })).rejects.toThrow('资产不存在')
  })

  it('加工素材：裁剪可从画面边缘开始，指定素材不误判来源已变化', async () => {
    const f = await fixture()
    const gray = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'gray' },
    })
      .png()
      .toBuffer()
    const red = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer()
    const a = await f.server.assets.ingest('local', Readable.from([gray]), {
      name: 'a.png',
      mime: 'image/png',
    })
    const b = await f.server.assets.ingest('local', Readable.from([red]), {
      name: 'b.png',
      mime: 'image/png',
    })
    const image = createElement(f.doc, {
      kind: 'image',
      x: 0,
      y: 0,
      w: 32,
      h: 32,
      assetId: a.id,
    })
    // crop 的 left/top 允许 0，拍平入参不能被 repair-region 的 ≥1 挡掉
    const cropped = (await f.invoke('edit_media', {
      element_id: image,
      op: 'crop',
      left: 0,
      top: 0,
      width: 16,
      height: 16,
    })) as { elements: Array<{ id: string }> }
    expect(cropped.elements[0]!.id).toBeTruthy()
    // 显式指定另一个素材加工时，来源并没有变化，不能误报来源已变化
    const derived = (await f.invoke('edit_media', {
      element_id: image,
      asset_id: b.id,
      op: 'rotate',
      angle: 90,
    })) as { elements: Array<{ id: string }> }
    expect(derived.elements[0]!.id).toBeTruthy()
    expect(f.doc.get(derived.elements[0]!.id)).toBeDefined()
    // 拍平层只收约束，不能替 op 填默认值：replace-range 的 start 是必填的
    await expect(
      f.invoke('edit_media', {
        op: 'replace-range',
        asset_id: a.id,
        replacementAssetId: b.id,
        end: 1,
      }),
    ).rejects.toThrow('参数不对')
    // 加工期间元素换了素材，仍然要拒绝写回画布
    const racing = new Proxy(f.server.assets, {
      get(target, prop, receiver) {
        if (prop !== 'ingest') return Reflect.get(target, prop, receiver)
        return async (...args: unknown[]) => {
          const asset = await (target.ingest as (...a: unknown[]) => Promise<unknown>)(...args)
          updateElement(f.doc, image, { assetId: b.id })
          return asset
        }
      },
    }) as AssetStore
    await expect(
      serverCapabilities.invoke('edit_media', serverContext({ ...f.env, assets: racing }), {
        element_id: image,
        op: 'rotate',
        angle: 90,
      }),
    ).rejects.toThrow('来源已变化')
  })
})
