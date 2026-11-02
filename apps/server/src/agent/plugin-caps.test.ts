import {
  definePlugin,
  definePluginCapability,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  PluginDescriptor,
  RPC_VERSION,
} from '@plein/plugin-sdk'
import type { Canvas, CapabilityCallResult, PluginCapabilityInfo } from '@plein/protocol'
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { proxyPlugin } from '../plugins/external'
import type { PluginProcess } from '../plugins/process'
import { request, startTestServer } from '../testing'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { McpServer } from './mcp'
import { agentTools, canvasTools } from './tools'

const caps = [
  definePluginCapability({
    id: 'acme/peek',
    title: '偷看',
    description: '只读能力，却想改画布',
    effect: 'read',
    input: z.object({}),
    run: (ctx) => ctx.call('create_element', { kind: 'markdown', text: 'x' }),
  }),
  definePluginCapability({
    id: 'acme/spend',
    title: '花钱',
    description: '会调模型',
    effect: 'run',
    input: z.object({}),
    run: () => 'spent',
  }),
]
const acme = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'acme/tools',
      version: '1.0.0',
      name: 'Acme 工具',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { capabilities: ['acme/peek', 'acme/spend'] },
    },
  }),
  { capabilities: caps },
)

/** 声明了 approval / prepare 的内置插件能力：声明经 plugin-caps 透传，调度器按声明分派 */
const declaredCaps = [
  definePluginCapability({
    id: 'acme2/answer',
    title: '预检短路',
    description: 'prepare 给出直接结果',
    effect: 'run',
    input: z.object({}),
    prepare: () => ({ answer: '预检结果' }),
    run: () => '不该执行',
  }),
  definePluginCapability({
    id: 'acme2/gated',
    title: '按声明确认',
    description: '声明审批说明：rules 不问，always 问',
    effect: 'run',
    input: z.object({}),
    approval: (_input, { mode }) =>
      mode === 'always' ? { reason: '声明里的说法', ids: [] } : null,
    prepare: () => null,
    run: () => 'ran',
  }),
]
const acme2 = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'acme2/tools',
      version: '1.0.0',
      name: 'Acme 声明',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { capabilities: ['acme2/answer', 'acme2/gated'] },
    },
  }),
  { capabilities: declaredCaps },
)
const bad = (id: string, capabilities: string[], cap: ReturnType<typeof definePluginCapability>) =>
  defineServerPlugin(
    definePlugin({
      manifest: {
        id,
        version: '1.0.0',
        name: id,
        engines: { plein: `^${PLUGIN_API_VERSION}` },
        contributes: { capabilities },
      },
    }),
    { capabilities: [cap] },
  )

let running: Awaited<ReturnType<typeof startTestServer>>
let canvasId: string
let seq = 0

beforeAll(async () => {
  running = await startTestServer()
  running.server.plugins.load(
    [
      acme,
      acme2,
      // 出现在命令面板里，输入却有必填项
      bad(
        'bad/palette',
        ['bad/need'],
        definePluginCapability({
          id: 'bad/need',
          title: '必填',
          description: '',
          effect: 'edit',
          palette: 'always',
          input: z.object({ text: z.string() }),
          run: () => '',
        }),
      ),
      // 清单没声明
      bad(
        'bad/undeclared',
        [],
        definePluginCapability({
          id: 'bad/x',
          title: 'x',
          description: '',
          effect: 'read',
          input: z.object({}),
          run: () => '',
        }),
      ),
    ],
    false,
  )
  const res = await fetch(`${running.url}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  canvasId = ((await res.json()) as Canvas).id
})

function mcpOf(server: McpServer) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: ++seq,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as { result: { content: Array<{ text?: string }>; isError?: boolean } }
    const text = r.result.content[0]?.text ?? ''
    return { error: r.result.isError === true, text }
  }
}

describe('插件贡献的能力', () => {
  it('清单与输入不合规的插件不加载', () => {
    const plugins = running.server.plugins.registry
    expect(plugins.plugin('acme/tools')?.status).toBe('active')
    expect(plugins.plugin('bad/palette')?.error).toMatch(/每个字段都要可选/)
    expect(plugins.plugin('bad/undeclared')?.error).toMatch(/contributes\.capabilities 缺少/)
  })

  it('出现在智能体工具里；插件改画布经自带能力，副作用不能超过声明的等级', async () => {
    const { rooms, runs, plugins, assets, library } = running.server
    const sticky = await createNote()
    const server = new McpServer(
      { name: 'plein', version: 'test' },
      canvasTools({
        canvasId,
        ownerId: 'local',
        rooms,
        runs,
        host: plugins,
        assets,
        library,
        selection: [sticky],
      }),
    )
    const call = mcpOf(server)
    const list = (await server.handle({ jsonrpc: '2.0', id: ++seq, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string; description: string }> }
    }
    const names = list.result.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['plein__mock_sticky', 'acme__peek']))
    expect(list.result.tools.find((t) => t.name === 'acme__peek')?.description).toContain(
      '来自插件 Acme 工具',
    )

    const made = await call('plein__mock_sticky', {})
    expect(made.error).toBe(false)
    const id = JSON.parse(made.text).id as string
    const text = rooms.withDoc(canvasId, (doc) => doc.get(id)?.text, undefined)
    expect(text).toBe('选中了：原稿')

    const peek = await call('acme__peek')
    expect(peek.error).toBe(true)
    expect(peek.text).toMatch(/声明的副作用是 read，不能调用 edit 级的 create_element/)
  })

  it('插件能力花钱时，规则模式下也要用户确认', async () => {
    const { rooms, runs, plugins, assets } = running.server
    const changes = new AgentChanges('agt_plugin', canvasId, 'local', rooms, runs)
    const approvals = new Approvals(() => {})
    const call = mcpOf(
      new McpServer(
        { name: 'plein', version: 'test' },
        agentTools(
          { canvasId, ownerId: 'local', rooms, runs, host: plugins, assets },
          { changes, approvals, mode: () => 'rules' },
        ),
      ),
    )
    changes.begin('t1')
    expect(JSON.parse((await call('acme__spend')).text).status).toBe('needs_approval')
    changes.release()
  })

  it('内置插件的 approval / prepare 声明经透传生效；第三方声明直接被拒', async () => {
    const { rooms, runs, plugins, assets } = running.server
    const env = { canvasId, ownerId: 'local', rooms, runs, host: plugins, assets }
    const build = (mode: 'rules' | 'always') => {
      const changes = new AgentChanges(`agt_declared_${mode}`, canvasId, 'local', rooms, runs)
      const server = new McpServer(
        { name: 'plein', version: 'test' },
        agentTools(env, { changes, approvals: new Approvals(() => {}), mode: () => mode }),
      )
      return { call: mcpOf(server), changes }
    }

    const rules = build('rules')
    // prepare 的 answer 直接返回给调用方，不执行原调用也不建确认单
    expect((await rules.call('acme2__answer')).text).toBe('预检结果')
    // rules 下声明返回 null：不问，直接执行
    expect((await rules.call('acme2__gated')).text).toBe('ran')

    // always 下声明自己给说法
    const always = build('always')
    const gated = JSON.parse((await always.call('acme2__gated')).text) as {
      status: string
      reason: string
    }
    expect(gated).toMatchObject({ status: 'needs_approval', reason: '声明里的说法' })

    // 第三方插件报上来的声明（哪怕是 approval / prepare）整批拒绝，不会生效
    const desc = PluginDescriptor.parse({
      rpc: RPC_VERSION,
      manifest: {
        id: 'acme3/late',
        version: '1.0.0',
        name: 'Acme 迟到',
        engines: { plein: '^0.1.0' },
      },
      sandbox: { permission: true, fsWrite: false, net: true },
      nodes: [],
      executors: [],
      providers: [],
      prompts: [],
      templates: [],
      elements: 0,
      capabilities: 1,
    })
    expect(() => proxyPlugin(desc, {} as unknown as PluginProcess)).toThrow(
      '第三方插件暂不支持能力',
    )
  })

  it('⌘K 经 HTTP 调用：列出能力、执行、整次撤销', async () => {
    const { server } = running
    const list = (await (
      await request(server, '/api/capabilities')
    ).json()) as PluginCapabilityInfo[]
    expect(list.find((c) => c.name === 'plein__mock_sticky')).toMatchObject({
      title: '贴一张便签（Mock）',
      palette: 'selection',
      plugin: 'Mock 平台',
    })

    const note = await createNote()
    const res = await request(server, `/api/canvases/${canvasId}/capabilities/plein__mock_sticky`, {
      method: 'POST',
      body: JSON.stringify({ input: { text: '记得配音' }, selection: [note] }),
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as CapabilityCallResult
    const id = JSON.parse(out.result).id as string
    const exists = () => server.rooms.withDoc(canvasId, (doc) => !!doc.get(id), false)
    expect(exists()).toBe(true)
    expect(out.undo).toBeTruthy()

    const undo = await request(server, `/api/capability-calls/${out.undo}/undo`, { method: 'POST' })
    expect(undo.status).toBe(204)
    expect(exists()).toBe(false)

    // 自带能力不走这个入口；插件出错时把原因告诉用户
    const builtin = await request(server, `/api/canvases/${canvasId}/capabilities/get_canvas`, {
      method: 'POST',
      body: '{}',
    })
    expect(builtin.status).toBe(404)
    const failed = await request(
      server,
      `/api/canvases/${canvasId}/capabilities/plein__mock_sticky`,
      {
        method: 'POST',
        body: '{}',
      },
    )
    expect(failed.status).toBe(422)
    expect(((await failed.json()) as { message: string }).message).toMatch(/先选中一个元素/)
  })
})

/** 画布上放一段名叫“原稿”的笔记 */
async function createNote() {
  const { rooms, runs, plugins, assets } = running.server
  const call = mcpOf(
    new McpServer(
      { name: 'plein', version: 'test' },
      canvasTools({ canvasId, ownerId: 'local', rooms, runs, host: plugins, assets }),
    ),
  )
  const r = await call('create_element', { kind: 'markdown', name: '原稿', text: '…' })
  return JSON.parse(r.text).id as string
}
