import {
  definePlugin,
  definePluginCapability,
  defineServerPlugin,
  PLUGIN_API_VERSION,
} from '@plein/plugin-sdk'
import { expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import { startTestServer } from '../testing'
import { Approvals } from './approvals'
import { AgentChanges } from './changes'
import { TurnExecution } from './execution'
import { callTool } from './mcp'
import { agentTools, canvasTools } from './tools'

it('blocks an asynchronous plugin write after stop and rechecks deferred approval before starting a run', async () => {
  const running = await startTestServer()
  const { rooms, runs, plugins, assets, library } = running.server
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const delayed = definePluginCapability({
    id: 'acme/delayed',
    title: 'delayed',
    description: '',
    effect: 'edit',
    input: z.object({}),
    run: async (ctx) => {
      entered()
      await waiting
      return ctx.call('create_element', { kind: 'markdown', text: 'must not appear' })
    },
  })
  plugins.load(
    [
      defineServerPlugin(
        definePlugin({
          manifest: {
            id: 'acme/guard-test',
            version: '1.0.0',
            name: 'guard test',
            engines: { plein: `^${PLUGIN_API_VERSION}` },
            contributes: { capabilities: ['acme/delayed'] },
          },
        }),
        { capabilities: [delayed] },
      ),
    ],
    false,
  )
  const response = await fetch(`${running.url}/api/canvases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const canvas = (await response.json()) as { id: string }
  const env = { canvasId: canvas.id, ownerId: 'local', rooms, runs, host: plugins, assets, library }
  const changes = new AgentChanges('guard', canvas.id, 'local', rooms, runs)
  const make = (id: string) => {
    const turn = new TurnExecution(
      id,
      () => true,
      () => {},
    )
    const approvals = new Approvals(() => {})
    const tools = agentTools(
      { ...env, execution: turn },
      { changes, approvals, mode: () => 'always' },
    )
    return { turn, tools, approvals }
  }
  changes.begin('first')
  const first = make('first')
  const tool = first.tools.find((t) => t.name === 'acme__delayed')!
  expect(tool).toBeDefined()
  const result = callTool(tool, {})
  await started
  first.turn.close('stopped')
  release()
  expect(await result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('turn_closed') }],
  })
  expect(rooms.withDoc(canvas.id, (doc) => doc.size)).toBe(0)
  changes.end()
  changes.begin('second')
  const creator = canvasTools(env).find((t) => t.name === 'create_node')!
  const made = await callTool(creator, { type: 'plein/image' })
  const node = JSON.parse(made.content[0]!.type === 'text' ? made.content[0]!.text : '') as {
    id: string
  }
  const second = make('second')
  const approvalResult = await callTool(
    second.tools.find((t) => t.name === 'run_node')!,
    { id: node.id, wait_seconds: 0 },
  )
  const pending = JSON.parse(
    approvalResult.content[0]!.type === 'text' ? approvalResult.content[0]!.text : '',
  ) as { approval_id: string }
  const start = vi.spyOn(runs, 'start')
  try {
    second.turn.close('stopped')
    second.approvals.decide(pending.approval_id, true)
    await expect(second.approvals.get(pending.approval_id)!.result).rejects.toThrow('turn_closed')
    expect(start).not.toHaveBeenCalled()
  } finally {
    start.mockRestore()
    changes.end()
    changes.release()
  }
})
