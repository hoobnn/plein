import { describe, expect, it, vi } from 'vite-plus/test'

vi.mock('../api/client', () => ({
  api: { upload: vi.fn(async () => ({ id: 'asset-1' })) },
}))
vi.mock('../features/stage/view', () => ({
  StageView: class {
    setScene() {}
    async snapshot() {
      return new Blob(['shot'])
    }
    dispose() {}
  },
}))

const { watchAgentRender } = await import('./agentRender')

/** 假的服务端与浏览器：awareness 的状态、请求和本地字段都在这里。 */
function fakeAwareness() {
  const local: Record<string, unknown> = {}
  const states = new Map<number, Record<string, unknown>>()
  const listeners = new Set<() => void>()
  const awareness = {
    clientID: 7,
    getStates: () => states,
    getLocalState: () => local,
    setLocalStateField: (field: string, value: unknown) => {
      local[field] = value
    },
    on: (event: string, cb: () => void) => {
      if (event === 'change') listeners.add(cb)
    },
    off: (_event: string, cb: () => void) => {
      listeners.delete(cb)
    },
  }
  const emit = () => {
    for (const cb of [...listeners]) cb()
  }
  return { awareness, local, states, emit }
}

/** 服务端挂在画布上的截图请求 */
const requests = (count: number, from = 0) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`req-${from + i}`, { client: 7, scene: {} }]),
  )

const results = (local: Record<string, unknown>) =>
  (local.canvasRenderResults ?? {}) as Record<string, { assetId?: string }>

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('浏览器端构图截图', () => {
  it('服务端还没取走的结果不会被后来的渲染挤掉', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, remove: () => {} }),
      body: { append: () => {} },
    })
    const { awareness, local, states } = fakeAwareness()
    states.set(1, { canvasRenderRequests: requests(9) })
    const stop = watchAgentRender(awareness as never)
    await until(() => Object.keys(results(local)).length === 9)
    expect(Object.keys(results(local))).toHaveLength(9)
    expect(results(local)['req-0']).toEqual({ assetId: 'asset-1' })
    stop()
  })

  it('服务端取走结果后，客户端在下一次渲染时清掉旧结果', async () => {
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, remove: () => {} }),
      body: { append: () => {} },
    })
    const { awareness, local, states, emit } = fakeAwareness()
    states.set(1, { canvasRenderRequests: requests(1) })
    const stop = watchAgentRender(awareness as never)
    await until(() => Object.keys(results(local)).length === 1)
    // 服务端读走结果后清掉请求，又挂了两个新的
    states.set(1, { canvasRenderRequests: requests(2, 1) })
    emit()
    await until(() => Object.keys(results(local)).length === 2)
    expect(Object.keys(results(local))).toEqual(['req-1', 'req-2'])
    stop()
  })
})
