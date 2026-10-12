import type { AgentSession, AgentSessionSummary } from '@plein/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { useAgent } from './agent'

vi.mock('../api/client', () => ({
  api: { agentSessions: vi.fn(), agentSession: vi.fn(), deleteAgentSession: vi.fn() },
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
  constructor(readonly url: string) {
    FakeEventSource.all.push(this)
  }
  close() {
    this.closed = true
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
})

describe('智能体会话', () => {
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
