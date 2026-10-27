// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { openDoc } from '@plein/doc/testing'
import type { StoryboardBatchPlan, StoryboardBatchRequest } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { BatchChecklist } from './BatchChecklist'

const canvasId = 'canvas-1'
const boardId = 'board-1'
const request: StoryboardBatchRequest = {
  shotIds: ['shot-1'],
  role: 'image',
  reuseExisting: false,
}

/** 手动放行的闸门：预检响应由用例决定什么时候到达。 */
function createGate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function planFor(body: StoryboardBatchRequest, revision: number): StoryboardBatchPlan {
  return {
    token: `token:${revision}`,
    expiresAt: Date.now() + 60_000,
    sourceId: boardId,
    request: body,
    scope: { canvasId, boardId, sequenceIds: [] },
    rows: [
      {
        key: 'shot-1',
        name: '镜头 1',
        prerequisite: false,
        action: 'run',
        reason: '为当前序列生成新候选',
        calls: 1,
      },
    ],
    summary: { run: 1, reuse: 0, blocked: 0, skip: 0, calls: 1, prices: [], unknownCalls: 0 },
  }
}

async function setup() {
  const doc = openDoc()
  const engine = { doc } as Engine
  useCanvas.setState({ engine, canvasId, sync: 'connected' })
  const previews: StoryboardBatchRequest[] = []
  const commits: unknown[] = []
  const gates: Array<ReturnType<typeof createGate>> = []
  const fetchMock = mockFetch(async (req) => {
    const path = new URL(req.url).pathname
    if (req.method === 'POST' && path.endsWith('/storyboard-batch/preview')) {
      const body = (await req.json()) as StoryboardBatchRequest
      previews.push(body)
      const gate = createGate()
      gates.push(gate)
      await gate.promise
      return Response.json(planFor(body, previews.length))
    }
    if (req.method === 'POST' && path.endsWith('/storyboard-batch/commit')) {
      commits.push(await req.json())
      return Response.json({ groupId: 'group', total: 1 })
    }
  })
  const started = vi.fn()
  const app = renderApp(
    <BatchChecklist
      engine={engine}
      canvasId={canvasId}
      boardId={boardId}
      request={request}
      onClose={() => {}}
      onLocate={() => {}}
      onStarted={started}
    />,
  )
  /** 提交接口实际被调用的次数（按真实请求路径统计）。 */
  const commitCalls = () =>
    fetchMock.mock.calls.filter(([input, init]) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      return (
        method === 'POST' &&
        new URL(url, location.href).pathname.endsWith('/storyboard-batch/commit')
      )
    }).length
  return { ...app, previews, commits, commitCalls, gates, started, doc }
}

/** 放行闸门，并让整条响应链（微任务 + 几次宏任务）处理完。 */
async function releaseGate(gate: ReturnType<typeof createGate>) {
  await act(async () => {
    gate.release()
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('断线后迟到的预检响应不恢复提交，界面仍要求重新检查', async () => {
  const { previews, commits, commitCalls, gates, started, unmount, doc } = await setup()
  try {
    await waitFor(() => expect(previews).toHaveLength(1))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认并开始生成' })
    // 预检还没回来就断线
    await act(async () => {
      useCanvas.setState({ sync: 'disconnected' })
    })
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText('当前未连接服务，恢复连接并重新检查后才能提交。')).toBeTruthy()
    // 断线前那次预检的响应此刻才到达
    await releaseGate(gates[0]!)
    expect(screen.getByText('内容或任务已变化，请重新检查清单。')).toBeTruthy()
    expect(screen.queryByLabelText('清单汇总')).toBeNull()
    expect(confirm.disabled).toBe(true)
    // 重连之后这份迟到的清单依然不能用
    await act(async () => {
      useCanvas.setState({ sync: 'connected' })
    })
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText('内容或任务已变化，请重新检查清单。')).toBeTruthy()
    expect(screen.queryByLabelText('清单汇总')).toBeNull()
    expect(commitCalls()).toBe(0)
    expect(commits).toEqual([])
    expect(started).not.toHaveBeenCalled()
  } finally {
    for (const gate of gates) gate.release()
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
    unmount()
    doc.destroy()
  }
})

it('重连后必须重新预检，新的预检返回前不能提交', async () => {
  const { user, previews, commits, commitCalls, gates, started, unmount, doc } = await setup()
  try {
    await waitFor(() => expect(previews).toHaveLength(1))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '确认并开始生成' })
    await act(async () => {
      useCanvas.setState({ sync: 'disconnected' })
    })
    expect(screen.getByText('当前未连接服务，恢复连接并重新检查后才能提交。')).toBeTruthy()
    await act(async () => {
      useCanvas.setState({ sync: 'connected' })
    })
    // 重连本身不恢复提交能力：清单仍要求重新检查
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText('内容或任务已变化，请重新检查清单。')).toBeTruthy()
    const refresh = screen.getByRole<HTMLButtonElement>('button', { name: '重新检查清单' })
    const before = previews.length
    await user.click(refresh)
    // 重新检查重新发起了一次预检
    await waitFor(() => expect(previews).toHaveLength(before + 1))
    // 新的预检还没回来，不能提交
    expect(confirm.disabled).toBe(true)
    expect(commitCalls()).toBe(0)
    await releaseGate(gates[gates.length - 1]!)
    // 重新检查完成后清单才重新可用，但全程没有产生任何提交
    await waitFor(() => expect(confirm.disabled).toBe(false))
    expect(screen.getByLabelText('清单汇总')).toBeTruthy()
    expect(commitCalls()).toBe(0)
    expect(commits).toEqual([])
    expect(started).not.toHaveBeenCalled()
  } finally {
    for (const gate of gates) gate.release()
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
    unmount()
    doc.destroy()
  }
})
