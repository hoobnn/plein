import type { ChatMessage, ChatTool, ProviderOutput } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import type { PluginHost } from '../plugins/host'
import { bootServer, createCanvas } from '../testing'
import { chatTools, closestTools, runBuiltinTurn } from './builtin'
import { builtinToolset, CORE_TOOLS, LOAD_TOOLS } from './builtin-tools'
import { textCost } from './context-budget'
import { defineTool, type McpTool } from './mcp'
import { INSTRUCTIONS } from './session-instructions'
import { agentTools, canvasTools } from './tools'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { AgentPlan } from './plan'

const extra = (name: string) =>
  defineTool({
    name,
    description: `${name} 的用途。更多说明。`,
    input: z.object({}),
    run: () => `${name} ran`,
  })

/** 按脚本逐步回复，并记录每一步请求带的工具名与收到的 tool 消息 */
function scriptedHost(
  steps: Array<Array<{ id: string; name: string; arguments?: Record<string, unknown> }>>,
) {
  const sent: string[][] = []
  const toolMessages: string[] = []
  let n = 0
  const host = {
    call: async (
      _cap: string,
      _model: string,
      input: { messages: ChatMessage[]; tools: ChatTool[] },
    ): Promise<{ outputs: ProviderOutput[] }> => {
      sent.push(input.tools.map((t) => t.name))
      toolMessages.length = 0
      for (const m of input.messages)
        if (m.role === 'tool' && typeof m.content === 'string') toolMessages.push(m.content)
      const calls = steps[n++]
      return calls
        ? { outputs: [{ type: 'tool_calls', calls: calls.map((c) => ({ arguments: {}, ...c })) }] }
        : { outputs: [{ type: 'text', text: 'done' }] }
    },
  } as unknown as PluginHost
  return { host, sent, toolMessages }
}

const run = (host: PluginHost, tools: McpTool[], loaded: string[]) =>
  runBuiltinTurn({
    host,
    model: 'm',
    ownerId: 'local',
    system: '',
    history: [],
    prompt: 'go',
    signal: new AbortController().signal,
    tools,
    loaded,
    onText: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
  })

describe('内置智能体工具按需加载', () => {
  const tools = [extra('get_element'), extra('run_frame'), extra('edit_shots'), extra('hidden')]

  it('首步只发核心集；load_tools 之后从下一步起追加，不重排', async () => {
    const { host, sent } = scriptedHost([
      [{ id: 'a', name: LOAD_TOOLS, arguments: { names: ['run_frame', 'edit_shots'] } }],
      [{ id: 'b', name: LOAD_TOOLS, arguments: { names: ['hidden'] } }],
    ])
    const loaded: string[] = []
    await run(host, tools, loaded)
    expect(sent[0]).toEqual(['get_element', LOAD_TOOLS])
    expect(sent[1]).toEqual(['get_element', LOAD_TOOLS, 'run_frame', 'edit_shots'])
    expect(sent[2]).toEqual(['get_element', LOAD_TOOLS, 'run_frame', 'edit_shots', 'hidden'])
    expect(loaded).toEqual(['run_frame', 'edit_shots', 'hidden'])
  })

  it('未知名字返回最接近的候选，已知的照常加载', async () => {
    const { host, sent, toolMessages } = scriptedHost([
      [{ id: 'a', name: LOAD_TOOLS, arguments: { names: ['run_fram', 'edit_shots'] } }],
    ])
    await run(host, tools, [])
    expect(sent[1]).toContain('edit_shots')
    expect(toolMessages.join('\n')).toContain('没有工具 run_fram；最接近的有：run_frame')
    expect(toolMessages.join('\n')).toContain('edit_shots（已加载）：edit_shots 的用途')
  })

  it('直接调用存在但未加载的工具：照常执行并自动加载', async () => {
    const { host, sent, toolMessages } = scriptedHost([[{ id: 'a', name: 'run_frame' }]])
    const loaded: string[] = []
    await run(host, tools, loaded)
    expect(toolMessages.join('\n')).toContain('run_frame ran')
    expect(sent[1]).toContain('run_frame')
    expect(loaded).toEqual(['run_frame'])
  })

  it('已加载集合跨轮保留', async () => {
    const loaded = ['run_frame']
    const { host, sent } = scriptedHost([])
    await run(host, tools, loaded)
    expect(sent[0]).toEqual(['get_element', LOAD_TOOLS, 'run_frame'])
  })
})

describe('核心工具集', () => {
  it('核心集的名字都真实存在，load_tools 不进 MCP 清单，定义体积明显小于全量', async () => {
    const { server } = await bootServer()
    const { id } = await createCanvas(server)
    const env = {
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
    const all = agentTools(env, {
      changes: new AgentChanges('t', id, 'local', server.rooms, server.runs),
      approvals: new Approvals(() => {}),
      mode: () => 'rules',
      plan: new AgentPlan(() => {}),
    })
    const names = new Set(all.map((t) => t.name))
    for (const name of CORE_TOOLS) if (name !== LOAD_TOOLS) expect(names.has(name), name).toBe(true)
    expect(names.has(LOAD_TOOLS)).toBe(false)
    expect(canvasTools(env).some((t) => t.name === LOAD_TOOLS)).toBe(false)

    // 对等的含义：全部工具都可经 load_tools 到达，而不是每次请求都发送
    const set = builtinToolset(all, [], closestTools)
    const loader = set.all.find((t) => t.name === LOAD_TOOLS)!
    await loader.run({ names: [...names] })
    expect(new Set(set.send().map((t) => t.name))).toEqual(new Set([...names, LOAD_TOOLS]))

    const core = all.filter((t) => CORE_TOOLS.includes(t.name))
    const full = textCost({ system: INSTRUCTIONS, tools: chatTools(all) }).tokens
    const lean = textCost({ system: INSTRUCTIONS, tools: chatTools(core) }).tokens
    expect(lean).toBeLessThan(full * 0.5)
  })
})
