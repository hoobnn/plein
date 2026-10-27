// @vitest-environment happy-dom
import { Selection, type Engine } from '@plein/canvas-core'
import { createElement, deleteElements, updateElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import type { AgentItem, AgentSession, AgentStatus } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { useSession } from '../../stores/session'
import { useCanvas } from '../../stores/canvas'
import { SelectionBar } from '../../shell/SelectionBar'
import { mockResizeObserver } from '../../testing/browser'
import { mockFetch } from '../../testing/fetch'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
  within,
} from '../../testing/render'
import { AgentDock, Transcript } from './Agent'
import { useAgent } from './store'

resetStoreAfterEach(useAgent)

const status: AgentStatus = {
  enabled: true,
  agents: [{ id: 'builtin', name: '内置智能体', available: true, model: 'Mock 智能体' }],
}
const canvasId = 'c1'

function session(id = 's1', patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    canvasId,
    agent: 'builtin',
    title: id === 's1' ? '原会话' : '目标会话',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    settings: {},
    context: { source: 'unavailable', messages: 0 },
    items: [],
    ...patch,
  }
}

function summary(value: AgentSession) {
  const { items: _items, ...rest } = value
  return rest
}

class FakeEventSource {
  static CLOSED = 2
  static all: FakeEventSource[] = []
  closed = false
  readyState = 1
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeEventSource.all.push(this)
  }
  close() {
    this.closed = true
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function prime(value = session()) {
  useAgent.setState({
    canvasId,
    session: value,
    sessions: [summary(value)],
    agent: 'builtin',
    status,
  })
}

function renderDock() {
  return renderApp(<AgentDock />, { route: { name: 'canvas', id: canvasId } })
}

async function openPanel(user: ReturnType<typeof renderDock>['user']) {
  await user.click(screen.getByRole('button', { name: '打开助手' }))
  return screen.getByRole('complementary', { name: '助手' })
}

beforeEach(() => {
  useAgent.getState().reset()
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
  useSession.setState({
    status: 'ready',
    info: { principal: { id: 'local', role: 'owner' }, authRequired: false, needsSetup: false },
  })
})

it('停止等待时禁止重复请求，失败显示错误并允许重试', async () => {
  prime(session('s1', { status: 'running' }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let stops = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'POST' && path === '/api/agent/sessions/s1/stop') {
      stops++
      if (stops === 1)
        return Response.json({ error: 'stop_failed', message: '停止测试失败' }, { status: 503 })
      return gate.then(() => new Response(null, { status: 204 }))
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  const stop = within(panel).getByRole<HTMLButtonElement>('button', { name: '停止' })
  await user.click(stop)
  expect((await within(panel).findByRole('alert')).textContent).toContain('停止测试失败')
  await user.click(stop)
  expect(stop.disabled).toBe(true)
  expect(within(panel).getByRole('status').textContent).toContain('正在停止…')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('complementary', { name: '助手' })).toBeNull()
  const reopened = await openPanel(user)
  const currentStop = within(reopened).getByRole<HTMLButtonElement>('button', { name: '停止' })
  expect(currentStop.disabled).toBe(true)
  expect(stops).toBe(2)
  release()
  await waitFor(() => expect(currentStop.disabled).toBe(false))
  expect(within(reopened).queryByRole('alert')).toBeNull()
})

it('撤销等待时关开面板仍禁止重复，失败后保留入口并可重试', async () => {
  const change: AgentItem = {
    id: 'change-1',
    type: 'changes',
    turn: 'turn-1',
    created: ['n1'],
    updated: [],
    deleted: [],
    edges: 0,
    runs: 1,
    undoable: true,
    at: 1,
  }
  prime(session('s1', { items: [change] }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let undos = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'POST' && path === '/api/agent/sessions/s1/turns/turn-1/undo') {
      undos++
      if (undos === 1)
        return Response.json({ error: 'undo_failed', message: '撤销测试失败' }, { status: 503 })
      return gate.then(() => new Response(null, { status: 204 }))
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  const undo = within(panel).getByRole<HTMLButtonElement>('button', { name: '撤销这一轮' })
  await user.click(undo)
  expect((await within(panel).findByRole('alert')).textContent).toContain('撤销测试失败')
  await user.click(undo)
  expect(undo.disabled).toBe(true)
  expect(undo.getAttribute('aria-busy')).toBe('true')
  await user.keyboard('{Escape}')
  const reopened = await openPanel(user)
  const currentUndo = within(reopened).getByRole<HTMLButtonElement>('button', {
    name: '撤销这一轮',
  })
  expect(currentUndo.disabled).toBe(true)
  expect(undos).toBe(2)
  release()
  await waitFor(() => expect(currentUndo.disabled).toBe(false))
  expect(within(reopened).queryByRole('alert')).toBeNull()
})

it('首次历史读取期间禁发，恢复后保留草稿并发送到原会话', async () => {
  const history = session('s1', {
    items: [{ id: 'old', type: 'text', text: '既有回复', at: 1 }],
  })
  useAgent.setState({ canvasId: null, session: null, sessions: [], agent: 'builtin', status })
  const list = deferred<Response>()
  const sent: Array<{ id: string; text: string }> = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'GET' && path === `/api/canvases/${canvasId}/agent/sessions`)
      return list.promise
    if (request.method === 'GET' && path === '/api/agent/sessions/s1') return Response.json(history)
    if (request.method === 'POST' && path === '/api/agent/sessions/s1/messages') {
      return request.json().then((body) => {
        sent.push({ id: 's1', text: (body as { text: string }).text })
        return new Response(null, { status: 202 })
      })
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
  await user.type(input, '等待期间的草稿')
  expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
  list.resolve(Response.json([summary(history)]))
  expect(await within(panel).findByText('既有回复')).toBeTruthy()
  expect(input.value).toBe('等待期间的草稿')
  await user.click(within(panel).getByRole('button', { name: '发送' }))
  await waitFor(() => expect(sent).toEqual([{ id: 's1', text: '等待期间的草稿' }]))
})

it('首次历史读取失败可重试，草稿保留且不会误发', async () => {
  const history = session('s1', {
    items: [{ id: 'old', type: 'text', text: '重读后的回复', at: 1 }],
  })
  useAgent.setState({ canvasId: null, session: null, sessions: [], agent: 'builtin', status })
  let lists = 0
  const sent: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'GET' && path === `/api/canvases/${canvasId}/agent/sessions`) {
      lists++
      return lists === 1
        ? Response.json({ error: 'history_failed', message: '历史读取失败' }, { status: 503 })
        : Response.json([summary(history)])
    }
    if (request.method === 'GET' && path === '/api/agent/sessions/s1') return Response.json(history)
    if (request.method === 'POST' && path === '/api/agent/sessions/s1/messages') {
      sent.push('s1')
      return new Response(null, { status: 202 })
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  expect((await within(panel).findByRole('alert')).textContent).toContain('历史读取失败')
  const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
  await user.type(input, '失败后保留的草稿')
  expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
  expect(sent).toEqual([])
  await user.click(within(panel).getByRole('button', { name: '重新读取' }))
  expect(await within(panel).findByText('重读后的回复')).toBeTruthy()
  expect(input.value).toBe('失败后保留的草稿')
  await user.click(within(panel).getByRole('button', { name: '发送' }))
  await waitFor(() => expect(sent).toEqual(['s1']))
})

it('目标历史详情失败可返回原对话，草稿和发送目标不串会话', async () => {
  mockResizeObserver()
  const old = session('old', {
    title: '原会话',
    items: [{ id: 'old-text', type: 'text', text: '原对话内容', at: 1 }],
  })
  const target = session('target', { title: '目标会话' })
  useAgent.setState({ canvasId: null, session: null, sessions: [], agent: 'builtin', status })
  const sent: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'GET' && path === `/api/canvases/${canvasId}/agent/sessions`)
      return Response.json([summary(old), summary(target)])
    if (request.method === 'GET' && path === '/api/agent/sessions/old') return Response.json(old)
    if (request.method === 'GET' && path === '/api/agent/sessions/target')
      return Response.json({ error: 'detail_failed', message: '目标详情失败' }, { status: 503 })
    if (request.method === 'POST' && path === '/api/agent/sessions/old/messages') {
      sent.push('old')
      return new Response(null, { status: 202 })
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  expect(await within(panel).findByText('原对话内容')).toBeTruthy()
  const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
  await user.type(input, '切换期间保留的草稿')
  await user.click(within(panel).getByRole('button', { name: '历史对话' }))
  const history = screen.getByRole('dialog', { name: '历史对话' })
  await user.click(within(history).getByRole('button', { name: /^目标会话/ }))
  expect((await within(panel).findByRole('alert')).textContent).toContain('目标详情失败')
  expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
  expect(input.value).toBe('切换期间保留的草稿')
  await user.click(within(panel).getByRole('button', { name: '返回原对话' }))
  await user.click(within(panel).getByRole('button', { name: '发送' }))
  await waitFor(() => expect(sent).toEqual(['old']))
  expect(input.value).toBe('')
})

it.each(['composing', 'legacy', 'end-229'] as const)(
  'IME %s 的 Enter/Escape 不发送也不关闭，普通 Escape 返回开关',
  async (mode) => {
    prime()
    const sent: string[] = []
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path === '/api/agent/models/builtin')
        return Response.json({ models: [] })
      if (request.method === 'POST' && path.includes('/agent/')) sent.push(path)
    })
    const { user } = renderDock()
    const panel = await openPanel(user)
    const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
    await user.type(input, '中文组字中的草稿')
    for (const key of ['Enter', 'Escape']) {
      fireEvent.compositionStart(input, { data: 'zhong' })
      if (mode === 'end-229') fireEvent.compositionEnd(input, { data: '中' })
      fireEvent.keyDown(input, {
        key,
        code: key,
        keyCode: mode === 'end-229' ? 229 : key === 'Enter' ? 13 : 27,
        isComposing: mode === 'composing',
      })
      expect(input.value).toBe('中文组字中的草稿')
      expect(panel.isConnected).toBe(true)
      fireEvent.compositionEnd(input, { data: '中' })
    }
    expect(sent).toEqual([])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: '助手' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开助手' })).toBe(document.activeElement)
  },
)

function engineFixture(names: string[]) {
  const doc = openDoc()
  const ids = names.map((name) => createElement(doc, node({ name })))
  doc.flush()
  const selection = new Selection()
  const engine = {
    doc,
    selection,
    flyTo: vi.fn(),
    zoomToFit: vi.fn(),
    flash: vi.fn(),
    camera: { insets: { left: 0 }, onInsetsChange: () => () => {} },
    scene: { rect: (id: string) => doc.worldRect(id) },
    worldToClient: (x: number, y: number) => ({ x, y }),
    onMove: () => () => {},
    onStateChange: () => () => {},
  } as unknown as Engine
  const select = (next: string[]) => {
    selection.set(next)
    useCanvas.setState({ selection: selection.size })
  }
  select(ids)
  useCanvas.setState({ engine, canvasId, selection: ids.length })
  return { doc, ids, engine, selection, select }
}

it('从多选工具条处理选区聚焦输入，全部目标逐个移除后不再显示 0 元素区域', async () => {
  prime()
  const fixture = engineFixture(['甲', '乙'])
  mockFetch((request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/models/builtin')
      return Response.json({ models: [] })
  })
  const { user } = renderApp(
    <>
      <SelectionBar remote />
      <AgentDock />
    </>,
    { route: { name: 'canvas', id: canvasId } },
  )
  await user.click(screen.getByRole('button', { name: '让小满处理' }))
  const panel = screen.getByRole('complementary', { name: '助手' })
  expect(within(panel).getByPlaceholderText('让小满帮你做点什么…')).toBe(document.activeElement)
  expect(within(panel).getByText('带上选中的 2 个元素')).toBeTruthy()
  await user.click(within(panel).getByRole('button', { name: '不带元素：甲' }))
  expect(within(panel).getByText('带上选中的 1 个元素')).toBeTruthy()
  await user.click(within(panel).getByRole('button', { name: '不带元素：乙' }))
  expect(within(panel).queryByText(/带上选中的/)).toBeNull()
  expect(within(panel).queryByLabelText('本轮画布目标')).toBeNull()
  fixture.doc.destroy()
})

it('选区顺序变化保留整体排除，换目标后发送剩余真实 ID', async () => {
  prime()
  const fixture = engineFixture(['甲', '乙', '丙'])
  const [a, b, c] = fixture.ids
  fixture.select([a!, b!])
  let body: { text?: string; selection?: string[] } | undefined
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/canvases/c1/agent/sessions')
      return Response.json([summary(session())])
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'POST' && path === '/api/agent/sessions/s1/messages') {
      return request.json().then((value) => {
        body = value as typeof body
        return new Response(null, { status: 202 })
      })
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  await user.click(within(panel).getByRole('button', { name: '不带选中元素' }))
  act(() => fixture.select([b!, a!]))
  expect(within(panel).queryByText(/带上选中的/)).toBeNull()
  act(() => fixture.select([b!, c!]))
  expect(await within(panel).findByText('带上选中的 2 个元素')).toBeTruthy()
  await user.click(within(panel).getByRole('button', { name: '不带元素：乙' }))
  const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
  await user.type(input, '只处理剩余目标')
  await user.click(within(panel).getByRole('button', { name: '发送' }))
  await waitFor(() => expect(body).toMatchObject({ text: '只处理剩余目标', selection: [c] }))
  fixture.doc.destroy()
})

it('工具与改动目标随删除和撤销撤下并恢复，展开状态保留', async () => {
  const fixture = engineFixture(['目标甲', '目标乙'])
  const [a, b] = fixture.ids
  prime()
  const items: AgentItem[] = [
    {
      id: 'approval-target',
      type: 'approval',
      tool: 'run_node',
      reason: '生成当前目标',
      ids: [a!],
      status: 'pending',
      at: 1,
    },
    {
      id: 'tool-1',
      type: 'tool',
      name: 'run_node',
      detail: `${a} · Mock`,
      status: 'done',
      output: '运行输出',
      at: 1,
    },
    {
      id: 'changes-1',
      type: 'changes',
      turn: 'turn-1',
      created: [a!, b!],
      updated: [],
      deleted: [],
      edges: 0,
      runs: 1,
      undoable: false,
      at: 1,
    },
  ]
  const { user } = renderApp(
    <Transcript items={items} running={false} intro="" worker="小满" lastTurn={undefined} />,
  )
  const summaryButton = screen.getByRole('button', { name: /^运行节点/ })
  await user.click(summaryButton)
  expect(screen.getByText('运行输出')).toBeTruthy()
  act(() => {
    updateElement(fixture.doc, a!, { name: '重命名目标' })
    fixture.doc.flush()
  })
  expect(summaryButton.textContent).toContain('重命名目标')
  act(() => {
    fixture.doc.undo.stopCapturing()
    deleteElements(fixture.doc, [a!])
    fixture.doc.flush()
  })
  expect(screen.queryByRole('button', { name: '在画布上定位' })).toBeNull()
  expect(screen.queryByRole('button', { name: '在画布上查看' })).toBeNull()
  expect(screen.getByRole('button', { name: '在画布上查看改动' })).toBeTruthy()
  expect(summaryButton.textContent).toContain('已删除')
  act(() => {
    fixture.doc.undo.stopCapturing()
    deleteElements(fixture.doc, [b!])
    fixture.doc.flush()
  })
  expect(screen.queryByRole('button', { name: '在画布上查看改动' })).toBeNull()
  act(() => {
    fixture.doc.undo.undo()
    fixture.doc.flush()
  })
  expect(screen.getByRole('button', { name: '在画布上查看改动' })).toBeTruthy()
  act(() => {
    fixture.doc.undo.undo()
    fixture.doc.flush()
  })
  expect(screen.getByRole('button', { name: '在画布上定位' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '在画布上查看' }))
  expect(fixture.engine.flyTo).toHaveBeenCalledWith([a])
  expect(screen.getByText('运行输出')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '在画布上查看改动' }))
  expect(new Set(fixture.selection.values())).toEqual(new Set([a, b]))
  fixture.doc.destroy()
})

it('旧版停止记录为中性提示，真实历史错误仍显示错误内容', () => {
  const items: AgentItem[] = [
    { id: 'stopped', type: 'error', text: '已停止', at: 1 },
    { id: 'failed', type: 'error', text: '平台执行失败，请核对任务', at: 1 },
  ]
  renderApp(<Transcript items={items} running={false} intro="" worker="小满" />)
  expect(screen.getByRole('status').textContent).toContain('已停止')
  expect(screen.getByText('平台执行失败，请核对任务')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('停止后的轮次解释保留改动与已提交任务，查看任务关闭助手而不重新提交', async () => {
  prime()
  useAgent.setState({ open: true })
  const items: AgentItem[] = [{ id: 'reply', type: 'text', text: '已创建本镜节点', at: 1 }]
  const { user } = renderApp(
    <Transcript
      items={items}
      running={false}
      intro=""
      worker="小满"
      lastTurn={{
        id: 'stopped-turn',
        state: 'stopped',
        reason: 'user_stopped',
        runs: [{ nodeId: 'video', runId: 'run-1' }],
        groups: ['group-1'],
      }}
    />,
  )
  const status = screen.getByRole('status')
  expect(within(status).getByText('本轮对话已停止')).toBeTruthy()
  expect(status.textContent).toContain('已完成的改动保留。已提交 1 次节点运行、1 组运行')
  expect(status.textContent).toContain('对话结束不代表生成任务失败，已提交的任务不会自动重发。')
  await user.click(within(status).getByRole('button', { name: '查看任务' }))
  expect(useCanvas.getState().tasks).toBe(true)
  expect(useAgent.getState().open).toBe(false)
  expect(useAgent.getState().session?.id).toBe('s1')
})

it('关闭的事件流可手动重试，重连期间保留草稿且禁止发送', async () => {
  prime()
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'GET' && path === '/api/agent/sessions/s1')
      return Response.json(session())
  })
  await useAgent.getState().select('s1')
  const stream = FakeEventSource.all.at(-1)!
  stream.readyState = FakeEventSource.CLOSED
  stream.onerror?.()
  const { user } = renderDock()
  let panel = await openPanel(user)
  await user.type(within(panel).getByPlaceholderText('让小满帮你做点什么…'), '重连期间保留的草稿')
  expect(within(panel).getByRole('alert').textContent).toContain('连接已断开')
  expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
  await user.click(within(panel).getByRole('button', { name: '重新连接' }))
  await user.keyboard('{Escape}')
  panel = await openPanel(user)
  expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '重新连接' }).disabled).toBe(
    true,
  )
  expect(within(panel).getByRole('status').textContent).toContain('正在重新连接')
  act(() => {
    const retry = FakeEventSource.all.at(-1)!
    retry.readyState = FakeEventSource.CLOSED
    retry.onerror?.()
  })
  await user.click(within(panel).getByRole('button', { name: '重新连接' }))
  act(() =>
    FakeEventSource.all.at(-1)!.onmessage?.({
      data: JSON.stringify({
        type: 'session',
        session: session('s1', {
          items: [{ id: 'reply', type: 'text', text: '补回的最新回复', at: 2 }],
        }),
      }),
    }),
  )
  expect(within(panel).getByText('补回的最新回复')).toBeTruthy()
  expect(within(panel).queryByRole('alert')).toBeNull()
  expect(within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…').value).toBe(
    '重连期间保留的草稿',
  )
  expect(FakeEventSource.all).toHaveLength(3)
})

it.each(['重新读取', '开始新对话'] as const)(
  '历史详情失败后可%s，保留草稿并明确发送目标',
  async (recovery) => {
    useAgent.setState({ canvasId: null, status, agent: 'builtin' })
    let reads = 0
    const sent: string[] = []
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && path === '/api/agent/models/builtin')
        return Response.json({ models: [] })
      if (path === '/api/canvases/c1/agent/sessions') {
        if (request.method === 'GET') return Response.json([summary(session())])
        if (request.method === 'POST') return Response.json(session('new'))
      }
      if (request.method === 'GET' && path === '/api/agent/sessions/s1') {
        reads++
        return reads === 1
          ? Response.json({ message: '详情暂不可读' }, { status: 503 })
          : Response.json(session())
      }
      if (request.method === 'POST' && /^\/api\/agent\/sessions\/(s1|new)\/messages$/.test(path)) {
        sent.push(path.split('/').at(-2)!)
        return new Response(null, { status: 204 })
      }
    })
    const { user } = renderDock()
    const panel = await openPanel(user)
    expect((await within(panel).findByRole('alert')).textContent).toContain('详情暂不可读')
    const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
    await user.type(input, '不丢的草稿')
    await user.keyboard('{Enter}')
    expect(sent).toEqual([])
    await user.click(within(panel).getByRole('button', { name: recovery }))
    await waitFor(() => expect(within(panel).queryByRole('alert')).toBeNull())
    expect(input.value).toBe('不丢的草稿')
    expect(input).toBe(document.activeElement)
    await user.click(within(panel).getByRole('button', { name: '发送' }))
    await waitFor(() => expect(sent).toEqual([recovery === '重新读取' ? 's1' : 'new']))
    expect(reads).toBe(recovery === '重新读取' ? 2 : 1)
  },
)

it('已处理的 Escape 不关面板，组字失焦后恢复正常关闭', async () => {
  prime()
  mockFetch((request) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/agent/models/builtin')
      return Response.json({ models: [] })
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  const input = within(panel).getByPlaceholderText('让小满帮你做点什么…')
  input.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(panel.isConnected).toBe(true)
  fireEvent.compositionStart(input, { data: 'zhong' })
  const close = within(panel).getByRole('button', { name: '关闭' })
  act(() => close.focus())
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('complementary', { name: '助手' })).toBeNull()
  expect(screen.getByRole('button', { name: '打开助手' })).toBe(document.activeElement)
})

it('历史消息的技能和目标保持原 ID，同名新元素不能替代已删除目标', async () => {
  const fixture = engineFixture(['目标甲'])
  const id = fixture.ids[0]!
  const items: AgentItem[] = [
    {
      id: 'request',
      type: 'user',
      text: '整理原目标',
      at: 1,
      selection: [id],
      skill: { id: 'plein:workflow', name: 'workflow', title: '整理工作流', source: 'plein' },
    },
  ]
  const { user } = renderApp(<Transcript items={items} running={false} intro="" worker="小满" />)
  expect(screen.getByText('技能：整理工作流')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '定位元素：目标甲' }))
  expect(fixture.engine.flyTo).toHaveBeenCalledWith([id])
  act(() => {
    deleteElements(fixture.doc, [id])
    createElement(fixture.doc, node({ name: '目标甲' }))
    fixture.doc.flush()
  })
  const removed = screen.getByRole<HTMLButtonElement>('button', { name: /^已删除元素：/ })
  expect(removed.disabled).toBe(true)
  expect(removed.title).toBe(id)
  expect(screen.queryByRole('button', { name: '定位元素：目标甲' })).toBeNull()
  fixture.doc.destroy()
})

it('删除正在打开的历史后迟到详情不恢复，删空列表回到输入且保留草稿', async () => {
  mockResizeObserver()
  const original = session()
  const target = session('target')
  prime(original)
  useAgent.setState({ sessions: [summary(original), summary(target)] })
  const detail = deferred<Response>()
  const removed: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/agent/models/builtin')
      return Response.json({ models: [] })
    if (request.method === 'GET' && path === '/api/agent/sessions/target') return detail.promise
    if (
      request.method === 'DELETE' &&
      ['/api/agent/sessions/s1', '/api/agent/sessions/target'].includes(path)
    ) {
      removed.push(path.split('/').at(-1)!)
      return new Response(null, { status: 204 })
    }
  })
  const { user } = renderDock()
  const panel = await openPanel(user)
  const input = within(panel).getByPlaceholderText<HTMLTextAreaElement>('让小满帮你做点什么…')
  await user.type(input, '切换期间的草稿')
  const history = within(panel).getByRole<HTMLButtonElement>('button', { name: '历史对话' })
  await user.click(history)
  expect(
    within(screen.getByRole('dialog', { name: '历史对话' })).getAllByText(/内置智能体/),
  ).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: /^目标会话/ }))
  expect(within(panel).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
  await user.click(input)
  await user.keyboard('{Enter}')
  await user.click(history)
  await user.click(screen.getByRole('button', { name: '删除对话：目标会话' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /^目标会话/ })).toBeNull())
  await act(async () => detail.resolve(Response.json(target)))
  expect(screen.getByRole('button', { name: /^原会话/ }).getAttribute('aria-pressed')).toBe('true')
  await user.click(screen.getByRole('button', { name: '删除对话：原会话' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '历史对话' })).toBeNull())
  expect(history.disabled).toBe(true)
  expect(input).toBe(document.activeElement)
  expect(input.value).toBe('切换期间的草稿')
  expect(removed).toEqual(['target', 's1'])
})
