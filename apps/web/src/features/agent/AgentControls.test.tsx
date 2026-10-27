// @vitest-environment happy-dom
import type { AgentSession } from '@plein/protocol'
import { beforeEach, expect, it } from 'vite-plus/test'
import { mockResizeObserver } from '../../testing/browser'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { AgentControls } from './AgentControls'
import { useAgent } from './store'

resetStoreAfterEach(useAgent)

const catalog = {
  defaultModel: 'codex-fast',
  models: [
    {
      id: 'codex-fast',
      title: 'Codex Fast',
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
    {
      id: 'codex-deep',
      title: 'Codex Deep',
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  ],
}

function session(id = 's1', patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    canvasId: 'c1',
    agent: 'codex',
    title: id,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    settings: { model: 'codex-fast', reasoningEffort: 'low' },
    context: { source: 'unavailable', messages: 2 },
    items: [],
    ...patch,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  mockResizeObserver()
  useAgent.setState({ canvasId: 'c1', agent: 'codex', session: session() })
})

it('模型保存失败保留原配置和草稿，重试成功后才更新', async () => {
  const original = session()
  useAgent.setState({ session: original })
  useAgent.getState().setDraft('c1', '修改模型时保留的草稿')
  const patches: unknown[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/canvases/c1/agent/sessions')
      return Response.json([original])
    if (request.method === 'GET' && path === '/api/agent/models/codex')
      return Response.json(catalog)
    if (request.method === 'PATCH' && path === '/api/agent/sessions/s1') {
      return request.json().then((body) => {
        patches.push(body)
        return patches.length === 1
          ? Response.json(
              { error: 'save_failed', message: '模型配置暂时无法保存' },
              { status: 503 },
            )
          : Response.json({ ...original, settings: body })
      })
    }
  })
  const { user } = renderApp(<AgentControls disabled={false} selectionCount={0} />)
  const model = await screen.findByRole<HTMLButtonElement>('combobox', { name: '对话模型' })
  await waitFor(() => expect(model.textContent).toContain('Codex Fast'))
  const chooseDeep = async () => {
    await user.click(model)
    await user.click(await screen.findByRole('option', { name: 'Codex Deep' }))
  }
  await chooseDeep()
  await waitFor(() => expect(useAgent.getState().error).toBe('模型配置暂时无法保存'))
  expect(model.textContent).toContain('Codex Fast')
  expect(useAgent.getState().drafts.c1?.text).toBe('修改模型时保留的草稿')
  await chooseDeep()
  await waitFor(() => expect(model.textContent).toContain('Codex Deep'))
  expect(patches).toEqual([{ model: 'codex-deep' }, { model: 'codex-deep' }])
  expect(useAgent.getState().drafts.c1?.text).toBe('修改模型时保留的草稿')
})

it('迟到的模型保存结果不覆盖已切换历史的配置或草稿', async () => {
  const original = session('old')
  const target = session('target', {
    settings: { model: 'codex-fast', reasoningEffort: 'high' },
  })
  useAgent.setState({ session: original })
  useAgent.getState().setDraft('c1', '目标历史的草稿')
  const pending = deferred<Response>()
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/codex')
      return Response.json(catalog)
    if (request.method === 'PATCH' && path === '/api/agent/sessions/old') return pending.promise
  })
  const { user } = renderApp(<AgentControls disabled={false} selectionCount={0} />)
  const model = await screen.findByRole<HTMLButtonElement>('combobox', { name: '对话模型' })
  await waitFor(() => expect(model.textContent).toContain('Codex Fast'))
  await user.click(model)
  await user.click(await screen.findByRole('option', { name: 'Codex Deep' }))
  await waitFor(() => expect(model.disabled).toBe(true))
  act(() => useAgent.setState({ session: target }))
  pending.resolve(Response.json({ ...original, settings: { model: 'codex-deep' } }))
  await waitFor(() => expect(useAgent.getState().pendingActions).toEqual({}))
  expect(useAgent.getState().session).toBe(target)
  expect(model.textContent).toContain('Codex Fast')
  expect(screen.getByRole('combobox', { name: '推理强度' }).textContent).toContain('高')
  expect(useAgent.getState().drafts.c1?.text).toBe('目标历史的草稿')
})

it('模型目录失败保留当前模型，显式刷新恢复且不改写会话', async () => {
  useAgent.setState({
    session: session('s1', { settings: { model: 'codex-deep', reasoningEffort: 'high' } }),
  })
  useAgent.getState().setDraft('c1', '目录读取期间的草稿')
  let requests = 0
  const patches: string[] = []
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/agent/models/codex') {
      requests++
      return requests === 1
        ? Response.json({ error: 'offline', message: '模型服务暂时离线' }, { status: 503 })
        : Response.json(catalog)
    }
    if (request.method === 'PATCH') patches.push(url.pathname)
  })
  const { user } = renderApp(<AgentControls disabled={false} selectionCount={0} />)
  const model = await screen.findByRole<HTMLButtonElement>('combobox', { name: '对话模型' })
  expect((await screen.findByRole('alert')).textContent).toContain('模型目录读取失败')
  expect(model.textContent).toContain('codex-deep')
  await user.click(screen.getByRole('button', { name: '重新读取模型' }))
  await waitFor(() => expect(model.textContent).toContain('Codex Deep'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(useAgent.getState().drafts.c1?.text).toBe('目录读取期间的草稿')
  expect(patches).toEqual([])
  expect(requests).toBe(2)
})

it.each(['estimate', 'unavailable'] as const)(
  '上下文来源 %s 不伪造未知模型预算百分比',
  async (source) => {
    useAgent.setState({
      session: session('s1', {
        context:
          source === 'estimate'
            ? { source, tokens: 8000, bytes: 24000, messages: 2, omittedRounds: 3 }
            : { source, messages: 2 },
      }),
    })
    mockFetch((request) => {
      if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/models/codex')
        return Response.json(catalog)
    })
    const { user } = renderApp(<AgentControls disabled={false} selectionCount={0} />)
    await user.click(await screen.findByRole('button', { name: '上下文管理' }))
    const dialog = await screen.findByRole('dialog', { name: '上下文管理' })
    expect(dialog.textContent).toContain(source === 'estimate' ? '估算' : '尚无可用的用量报告')
    expect(dialog.textContent).not.toMatch(/\d+(?:\.\d+)?\s*%/)
    expect(screen.queryByRole('progressbar')).toBeNull()
    if (source === 'estimate') {
      expect(dialog.textContent).toContain('较早的 3 组历史未发送')
      expect(dialog.textContent).toContain('24,000 bytes')
    }
  },
)

it('重置失败保留历史和草稿，成功后显示重新建立上下文且保留已有记录', async () => {
  const original = session('s1', {
    context: { source: 'provider', tokens: 12000, limit: 100000, messages: 2 },
    items: [{ id: 'reply', type: 'text', text: '已有回复', at: 1 }],
  })
  useAgent.setState({ session: original })
  useAgent.getState().setDraft('c1', '继续创作')
  let resets = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/codex')
      return Response.json(catalog)
    if (request.method === 'GET' && path === '/api/canvases/c1/agent/sessions')
      return Response.json([original])
    if (request.method === 'POST' && path === '/api/agent/sessions/s1/context/reset') {
      resets++
      return resets === 1
        ? Response.json({ message: '上下文暂时无法重置' }, { status: 503 })
        : Response.json({
            ...original,
            context: { source: 'unavailable', messages: 0, resetAt: 1 },
          })
    }
  })
  const { user } = renderApp(<AgentControls disabled={false} selectionCount={2} />)
  await user.click(screen.getByRole('button', { name: '上下文管理' }))
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('12')
  expect(screen.getByText('2 个元素')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '重置上下文' }))
  await waitFor(() => expect(useAgent.getState().error).toBe('上下文暂时无法重置'))
  expect(useAgent.getState().session).toBe(original)
  await user.click(screen.getByRole('button', { name: '重置上下文' }))
  expect((await screen.findByRole('status')).textContent).toContain('重新建立上下文')
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(useAgent.getState().session?.items).toEqual(original.items)
  expect(useAgent.getState().drafts.c1?.text).toBe('继续创作')
  expect(resets).toBe(2)
})

it('恢复 CLI 默认提交空配置并撤下旧推理强度', async () => {
  const original = session()
  const patches: unknown[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/codex')
      return Response.json(catalog)
    if (request.method === 'GET' && path === '/api/canvases/c1/agent/sessions')
      return Response.json([original])
    if (request.method === 'PATCH' && path === '/api/agent/sessions/s1')
      return request.json().then((settings) => {
        patches.push(settings)
        return Response.json({ ...original, settings })
      })
  })
  const { user } = renderApp(<AgentControls disabled={false} selectionCount={0} />)
  const model = screen.getByRole<HTMLButtonElement>('combobox', { name: '对话模型' })
  await waitFor(() => expect(model.disabled).toBe(false))
  await user.click(model)
  await user.click(screen.getByRole('option', { name: '跟随 CLI 配置' }))
  await waitFor(() => expect(screen.queryByRole('combobox', { name: '推理强度' })).toBeNull())
  expect(patches).toEqual([{}])
  expect(model.textContent).toBe('跟随 CLI 配置')
})

it('业务忙碌时禁用模型与推理配置，仍可只读查看上下文', async () => {
  mockFetch((request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/models/codex')
      return Response.json(catalog)
  })
  const { user } = renderApp(<AgentControls disabled selectionCount={0} />)
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: '对话模型' }).textContent).toBe('Codex Fast'),
  )
  expect(screen.getByRole<HTMLButtonElement>('combobox', { name: '对话模型' }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('combobox', { name: '推理强度' }).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '上下文管理' }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '重置上下文' }).disabled).toBe(true)
})
