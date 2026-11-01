import { afterEach, expect, it, vi } from 'vite-plus/test'
import { bootServer } from '../testing'
import { runBuiltinTurn } from './builtin'

afterEach(() => vi.restoreAllMocks())
it('套餐文本可驱动内置 Agent，但不能成为画布默认模型或直接调用', async () => {
  const { server } = await bootServer()
  const host = server.plugins
  host.configs.update('volc/ark-plan', {
    enabled: true,
    secrets: { ARK_AGENT_PLAN_API_KEY: 'test-plan' },
  })
  const ref = 'volc/ark-plan:doubao-seed-2.1-pro'
  expect((await server.agents.models('builtin')).models.some((m) => m.id === ref)).toBe(true)
  expect(host.models('text.chat').some((m) => m.ref === ref)).toBe(false)
  host.configs.setDefaultModel('text.chat', ref)
  expect(host.defaultModel('text.chat')).not.toBe(ref)
  const submit = vi
    .spyOn(host.registry.providers.get('volc/ark-plan')!.def, 'submit')
    .mockResolvedValueOnce({
      state: 'succeeded',
      outputs: [
        {
          type: 'tool_calls',
          calls: [{ id: 'call1', name: 'get_canvas', arguments: {} }],
          continuation: { model: 'doubao-seed-2.1-pro', encryptedContent: 'opaque' },
        },
      ],
    })
    .mockResolvedValue({ state: 'succeeded', outputs: [{ type: 'text', text: '你好' }] })
  const input = { messages: [{ role: 'user' as const, content: 'hi' }] }
  await expect(host.call('text.chat', ref, input, { ownerId: 'local' })).rejects.toMatchObject({
    code: 'invalid_input',
  })
  expect(submit).not.toHaveBeenCalled()
  const onText = vi.fn()
  await runBuiltinTurn({
    host,
    model: ref,
    ownerId: 'local',
    system: 'assistant',
    history: [],
    prompt: 'hi',
    tools: [],
    signal: new AbortController().signal,
    onText,
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
  })
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'doubao-seed-2.1-pro', usage: 'agent' }),
    expect.anything(),
  )
  expect(onText).toHaveBeenCalledWith('s1', '你好', true)
  expect(submit.mock.calls[1]?.[0].input).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        continuation: { model: 'doubao-seed-2.1-pro', encryptedContent: 'opaque' },
      }),
    ]),
  })
})

it('新发现的套餐文本保留 Agent 限制，换 Key 后目录失效', async () => {
  const { server } = await bootServer()
  const host = server.plugins
  host.configs.update('volc/ark-plan', {
    enabled: true,
    secrets: { ARK_AGENT_PLAN_API_KEY: 'test-plan' },
  })
  vi.spyOn(host.registry.providers.get('volc/ark-plan')!.def, 'listRemoteModels').mockResolvedValue(
    [{ id: 'new-chat', kind: 'llm', agentOnly: true, features: ['tools'] }],
  )
  await host.refreshRemoteModels('volc/ark-plan', 'local')
  const ref = 'volc/ark-plan:new-chat'
  expect((await server.agents.models('builtin')).models.some((m) => m.id === ref)).toBe(true)
  await expect(
    host.call(
      'text.chat',
      ref,
      { messages: [{ role: 'user', content: 'hi' }] },
      { ownerId: 'local' },
    ),
  ).rejects.toThrow('仅供')
  host.configs.update('volc/ark-plan', { secrets: { ARK_AGENT_PLAN_API_KEY: 'changed-plan' } })
  expect((await server.agents.models('builtin')).models.some((m) => m.id === ref)).toBe(false)
})
