import type { AgentEvent, AgentSession, AgentSessionSummary } from '@plein/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { useAgent } from './store'

vi.mock('../../api/client', () => ({
  api: {
    agentSessions: vi.fn(),
    agentSession: vi.fn(),
    deleteAgentSession: vi.fn(),
    createAgentSession: vi.fn(),
    sendAgentMessage: vi.fn(),
  },
}))

/** 手动放行的应答：按顺序控制谁先到 */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const session = (id: string) => ({ id, status: 'idle', items: [] }) as unknown as AgentSession
const summary = (id: string) => ({ id }) as unknown as AgentSessionSummary

/** 记下连过的事件流，看哪些被关掉了 */
class FakeEventSource {
  static CLOSED = 2
  static all: FakeEventSource[] = []
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeEventSource.all.push(this)
  }
  close() {
    this.closed = true
  }
  emit(event: AgentEvent) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

const initial = useAgent.getState()
beforeEach(() => {
  FakeEventSource.all = []
  vi.stubGlobal('EventSource', FakeEventSource)
  useAgent.setState(initial, true)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(api.agentSession).mockReset()
  vi.mocked(api.agentSessions).mockReset()
  vi.mocked(api.deleteAgentSession).mockReset()
  vi.mocked(api.createAgentSession).mockReset()
  vi.mocked(api.sendAgentMessage).mockReset()
})

describe('助手草稿与发送生命周期', () => {
  it('按画布保留草稿，关闭面板和切换画布不覆盖其他草稿，空草稿移除', async () => {
    vi.mocked(api.agentSessions).mockResolvedValue([])
    await useAgent.getState().enter('c1')
    useAgent.getState().setDraft('c1', '第一块画布')
    useAgent.getState().toggle(false)
    await useAgent.getState().enter('c2')
    useAgent.getState().setDraft('c2', '第二块画布')
    expect(useAgent.getState().drafts).toEqual({
      c1: { text: '第一块画布' },
      c2: { text: '第二块画布' },
    })
    useAgent.getState().setDraft('c2', '')
    expect(useAgent.getState().drafts).toEqual({ c1: { text: '第一块画布' } })
  })

  it('待提交时阻止重复请求，冻结发送选项，迟到成功不清除修改后又相同的草稿', async () => {
    useAgent.setState({ canvasId: 'c1', agent: 'builtin', approval: 'rules', plan: false })
    useAgent.getState().setDraft('c1', '原稿')
    const pending = deferred<AgentSession>()
    vi.mocked(api.createAgentSession).mockReturnValue(pending.promise)
    vi.mocked(api.sendAgentMessage).mockResolvedValue(undefined)
    vi.mocked(api.agentSessions).mockResolvedValue([])
    const task = useAgent.getState().send('原稿', ['n1'])
    await useAgent.getState().send('重复发送')
    expect(api.createAgentSession).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().sending.c1).toBe(true)
    useAgent.setState({ plan: true })
    useAgent.getState().setDraft('c1', '修改稿')
    useAgent.getState().setDraft('c1', '原稿')
    pending.resolve({ ...session('s1'), agent: 'builtin' })
    await task
    expect(api.sendAgentMessage).toHaveBeenCalledWith(
      's1',
      '原稿',
      ['n1'],
      expect.objectContaining({ plan: false }),
    )
    expect(useAgent.getState().drafts.c1?.text).toBe('原稿')
    expect(useAgent.getState().sending.c1).toBeUndefined()
  })

  it('失败保留原稿并释放发送状态，用户再次发送成功才清空', async () => {
    vi.useFakeTimers()
    try {
      useAgent.setState({ canvasId: 'c1', agent: 'builtin' })
      useAgent.getState().setDraft('c1', ' 原稿 ')
      vi.mocked(api.createAgentSession).mockRejectedValueOnce(new Error('发送失败'))
      await useAgent.getState().send('原稿')
      expect(useAgent.getState()).toMatchObject({
        error: '发送失败',
        sending: {},
        drafts: { c1: { text: ' 原稿 ' } },
      })
      vi.mocked(api.createAgentSession).mockResolvedValue({ ...session('s1'), agent: 'builtin' })
      vi.mocked(api.sendAgentMessage).mockResolvedValue(undefined)
      vi.mocked(api.agentSessions).mockResolvedValue([])
      await useAgent.getState().send('原稿')
      expect(useAgent.getState().drafts).toEqual({})
      expect(useAgent.getState().sending).toEqual({})
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('创建会话期间换画布或重置会话，不发送旧请求，也不清除原画布草稿', async () => {
    vi.mocked(api.agentSessions).mockResolvedValue([])
    for (const change of ['canvas', 'reset']) {
      useAgent.setState({ canvasId: 'c1', session: null, agent: 'builtin' })
      useAgent.getState().setDraft('c1', '原画布草稿')
      const pending = deferred<AgentSession>()
      vi.mocked(api.createAgentSession).mockReturnValue(pending.promise)
      const task = useAgent.getState().send('原画布草稿')
      if (change === 'canvas') await useAgent.getState().enter('c2')
      else useAgent.getState().reset()
      pending.resolve({ ...session('s1'), agent: 'builtin' })
      await task
      expect(api.sendAgentMessage).not.toHaveBeenCalled()
      expect(useAgent.getState().session).toBeNull()
      expect(useAgent.getState().drafts.c1?.text).toBe('原画布草稿')
      expect(useAgent.getState().sending).toEqual({})
    }
  })
})

describe('智能体会话', () => {
  it('删除当前会话不取消用户正在打开的另一会话', async () => {
    const pending = deferred<AgentSession>()
    vi.mocked(api.agentSession).mockReturnValue(pending.promise)
    vi.mocked(api.deleteAgentSession).mockResolvedValue(undefined)
    useAgent.setState({ canvasId: 'c1', session: session('old') })
    const opening = useAgent.getState().select('next')
    await useAgent.getState().remove('old')
    pending.resolve(session('next'))
    await opening
    expect(useAgent.getState().session?.id).toBe('next')
  })
  it('删除正在打开的会话后，迟到内容不再恢复已删除会话', async () => {
    const pending = deferred<AgentSession>()
    vi.mocked(api.agentSession).mockReturnValue(pending.promise)
    vi.mocked(api.deleteAgentSession).mockResolvedValue(undefined)
    useAgent.setState({ canvasId: 'c1', sessions: [summary('s1')] })
    const opening = useAgent.getState().select('s1')
    await useAgent.getState().remove('s1')
    pending.resolve(session('s1'))
    await opening
    expect(useAgent.getState().session).toBeNull()
    expect(useAgent.getState().sessions).toEqual([])
  })

  it('切换会话期间不向旧会话发送，删除请求等待中不重复删除', async () => {
    const opening = deferred<AgentSession>()
    const removing = deferred<void>()
    vi.mocked(api.agentSession).mockReturnValue(opening.promise)
    vi.mocked(api.deleteAgentSession).mockReturnValue(removing.promise)
    useAgent.setState({
      canvasId: 'c1',
      agent: 'builtin',
      session: { ...session('old'), agent: 'builtin' },
    })
    const selectTask = useAgent.getState().select('next')
    await useAgent.getState().send('不能发到旧会话')
    expect(api.sendAgentMessage).not.toHaveBeenCalled()
    const removeTask = useAgent.getState().remove('other')
    const duplicate = useAgent.getState().remove('other')
    expect(api.deleteAgentSession).toHaveBeenCalledTimes(1)
    removing.resolve()
    await Promise.all([removeTask, duplicate])
    opening.resolve(session('next'))
    await selectTask
    expect(useAgent.getState().session?.id).toBe('next')
  })

  it('删除失败的旧画布应答不污染当前画布', async () => {
    const pending = deferred<void>()
    vi.mocked(api.deleteAgentSession).mockReturnValue(
      pending.promise.then(() => {
        throw new Error('旧画布删除失败')
      }),
    )
    vi.mocked(api.agentSessions).mockResolvedValue([])
    useAgent.setState({ canvasId: 'c1' })
    const task = useAgent.getState().remove('old')
    await useAgent.getState().enter('c2')
    pending.resolve()
    await task
    expect(useAgent.getState().error).toBeNull()
  })
  it('保存轮次清算状态，停止和中断不显示为生成失败；旧事件流不会覆盖当前会话', async () => {
    vi.mocked(api.agentSession).mockImplementation(async (id) => session(id))
    vi.mocked(api.agentSessions).mockResolvedValue([])
    useAgent.setState({ canvasId: 'c1' })
    await useAgent.getState().select('a')
    const first = FakeEventSource.all.at(-1)!
    first.emit({
      type: 'status',
      status: 'running',
      lastTurn: { id: 't1', state: 'running', runs: [], groups: [] },
    })
    first.emit({
      type: 'status',
      status: 'idle',
      lastTurn: { id: 't1', state: 'stopped', runs: [{ nodeId: 'n', runId: 'r' }], groups: ['g'] },
    })
    expect(useAgent.getState()).toMatchObject({
      mood: 'idle',
      session: {
        status: 'idle',
        lastTurn: { state: 'stopped', runs: [{ runId: 'r' }], groups: ['g'] },
      },
    })
    await useAgent.getState().select('b')
    first.emit({ type: 'session', session: session('a') })
    expect(useAgent.getState().session?.id).toBe('b')
    const current = FakeEventSource.all.at(-1)!
    current.emit({
      type: 'session',
      session: {
        ...session('b'),
        lastTurn: { id: 't2', state: 'interrupted', runs: [], groups: [] },
      },
    })
    expect(useAgent.getState().session?.lastTurn?.state).toBe('interrupted')
  })
  it('连点两个会话，先点的晚到也不会盖掉后点的', async () => {
    const pending = { a: deferred<AgentSession>(), b: deferred<AgentSession>() }
    vi.mocked(api.agentSession).mockImplementation((id) => pending[id as 'a' | 'b'].promise)
    useAgent.setState({ canvasId: 'c1' })
    const a = useAgent.getState().select('a')
    const b = useAgent.getState().select('b')
    pending.b.resolve(session('b'))
    await b
    pending.a.resolve(session('a'))
    await a
    expect(useAgent.getState().session?.id).toBe('b')
    // 只连了 b 的事件流
    expect(FakeEventSource.all.map((s) => s.url)).toEqual([expect.stringContaining('b')])
  })

  it('切到别的画布后，上一块画布晚到的会话列表丢掉', async () => {
    const pending = { c1: deferred<AgentSessionSummary[]>(), c2: deferred<AgentSessionSummary[]>() }
    vi.mocked(api.agentSessions).mockImplementation((id) => pending[id as 'c1' | 'c2'].promise)
    vi.mocked(api.agentSession).mockImplementation(async (id) => session(id))
    const first = useAgent.getState().enter('c1')
    const second = useAgent.getState().enter('c2')
    pending.c2.resolve([summary('s2')])
    await second
    pending.c1.resolve([summary('s1')])
    await first
    const s = useAgent.getState()
    expect(s.canvasId).toBe('c2')
    expect(s.sessions).toEqual([summary('s2')])
    expect(s.session?.id).toBe('s2')
    expect(api.agentSession).not.toHaveBeenCalledWith('s1')
  })

  it('删掉当前会话时回到空白对话并断开事件流；删失败时保留', async () => {
    vi.mocked(api.agentSession).mockImplementation(async (id) => session(id))
    useAgent.setState({ canvasId: 'c1', sessions: [summary('s1'), summary('s2')] })
    await useAgent.getState().select('s1')
    vi.mocked(api.deleteAgentSession).mockRejectedValueOnce(new Error('忙'))
    await useAgent.getState().remove('s1')
    expect(useAgent.getState()).toMatchObject({ session: { id: 's1' }, error: '忙' })
    vi.mocked(api.deleteAgentSession).mockResolvedValueOnce(undefined)
    await useAgent.getState().remove('s1')
    const s = useAgent.getState()
    expect(s.session).toBeNull()
    expect(s.sessions).toEqual([summary('s2')])
    expect(FakeEventSource.all[0]!.closed).toBe(true)
  })

  it('删掉别的会话不影响当前会话', async () => {
    vi.mocked(api.agentSession).mockImplementation(async (id) => session(id))
    vi.mocked(api.deleteAgentSession).mockResolvedValue(undefined)
    useAgent.setState({ canvasId: 'c1', sessions: [summary('s1'), summary('s2')] })
    await useAgent.getState().select('s1')
    await useAgent.getState().remove('s2')
    expect(useAgent.getState().session?.id).toBe('s1')
    expect(useAgent.getState().sessions).toEqual([summary('s1')])
  })
})
