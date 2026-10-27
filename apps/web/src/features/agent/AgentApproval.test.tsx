// @vitest-environment happy-dom
import type { AgentItem, AgentSession, StoryboardBatchPlan } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { Transcript } from './Agent'
import { useAgent } from './store'

resetStoreAfterEach(useAgent)

function prime(item: AgentItem) {
  const session: AgentSession = {
    id: 's1',
    canvasId: 'c1',
    agent: 'builtin',
    title: '审批',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    items: [item],
  }
  useAgent.setState({ canvasId: 'c1', session })
}

it.each([
  ['approved', '已允许', true],
  ['denied', '已跳过', false],
  ['expired', '已过期', undefined],
] as const)('运行确认从待批准变为 %s 时显示对应结果且撤下操作', async (status, label, allow) => {
  const approval: Extract<AgentItem, { type: 'approval' }> = {
    id: 'run-approval',
    type: 'approval',
    tool: 'run_node',
    reason: '生成本镜视频',
    ids: [],
    status: 'pending',
    at: 1,
  }
  prime(approval)
  const decisions: unknown[] = []
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/run-approval'
    )
      return request.json().then((body) => {
        decisions.push(body)
        return new Response(null, { status: 204 })
      })
  })
  const view = renderApp(<Transcript items={[approval]} running={false} intro="" worker="小满" />)
  expect(screen.getByText('需要你确认：生成本镜视频')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '允许' }).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '跳过' }).disabled).toBe(false)
  if (allow !== undefined) {
    await view.user.click(screen.getByRole('button', { name: allow ? '允许' : '跳过' }))
    await waitFor(() => expect(useAgent.getState().pendingActions).toEqual({}))
  }
  view.rerender(
    <Transcript items={[{ ...approval, status }]} running={false} intro="" worker="小满" />,
  )
  expect(screen.getByText(`${label}：生成本镜视频`)).toBeTruthy()
  expect(screen.queryByText('需要你确认：生成本镜视频')).toBeNull()
  expect(screen.queryByRole('button', { name: '允许' })).toBeNull()
  expect(screen.queryByRole('button', { name: '跳过' })).toBeNull()
  expect(decisions).toEqual(allow === undefined ? [] : [{ allow }])
})

it('计划确认失败可重试，重挂载仍锁定相反选择且只提交一次', async () => {
  const plan: AgentItem = {
    id: 'plan',
    type: 'plan',
    status: 'pending',
    summary: '生成画面',
    steps: [{ title: '生成图片', status: 'todo' }],
    at: 1,
  }
  prime(plan)
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  const decisions: unknown[] = []
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/plan'
    )
      return request.json().then((body) => {
        decisions.push(body)
        return decisions.length === 1
          ? Response.json({ message: '确认暂时失败' }, { status: 503 })
          : pending
      })
  })
  const row = <Transcript items={[plan]} running={false} intro="" worker="小满" />
  const view = renderApp(row)
  await view.user.click(screen.getByRole('button', { name: '同意并执行' }))
  await waitFor(() => expect(useAgent.getState().error).toBe('确认暂时失败'))
  await view.user.click(screen.getByRole('button', { name: '同意并执行' }))
  view.rerender(<></>)
  view.rerender(row)
  const approve = screen.getByRole<HTMLButtonElement>('button', { name: '同意并执行' })
  const deny = screen.getByRole<HTMLButtonElement>('button', { name: '不用了' })
  expect(approve.disabled).toBe(true)
  expect(deny.disabled).toBe(true)
  await view.user.click(deny)
  expect(decisions).toEqual([{ allow: true }, { allow: true }])
  release(new Response(null, { status: 204 }))
  await waitFor(() => expect(approve.disabled).toBe(false))
  expect(useAgent.getState().error).toBeNull()
})

it('分镜批量确认显示冻结清单与输入，失败可重试，历史不再提供批准入口', async () => {
  const plan: Omit<StoryboardBatchPlan, 'token'> = {
    expiresAt: Date.now() + 600_000,
    sourceId: 'board',
    request: { shotIds: ['s1', 's2', 's3', 's4'], role: 'image', reuseExisting: true },
    rows: [
      {
        key: 'one',
        nodeId: 'one',
        shotNo: 1,
        name: '天台近景',
        prerequisite: false,
        action: 'run',
        reason: '按这份实际输入生成新候选',
        calls: 1,
        input: {
          v: 1,
          nodeId: 'one',
          nodeType: 'plein/image',
          preparedAt: 1,
          status: 'ready',
          model: { ref: 'mock:image', provider: 'mock', title: 'Mock 图片' },
          prompt: '冻结输入：天台逆光近景',
          params: { aspectRatio: '9:16' },
          inputs: {},
          refs: [],
          notices: [],
          blocked: [],
        },
      },
      {
        key: 'two',
        shotNo: 2,
        name: '原有远景',
        prerequisite: false,
        action: 'reuse',
        reason: '沿用当前采用结果',
        calls: 0,
      },
      {
        key: 'three',
        shotNo: 3,
        name: '待取回镜头',
        prerequisite: false,
        action: 'blocked',
        reason: '请先核查或取回原任务',
        calls: 0,
      },
      {
        key: 'four',
        shotNo: 4,
        name: '空对白',
        prerequisite: false,
        action: 'skip',
        reason: '没有台词',
        calls: 0,
      },
    ],
    summary: { run: 1, reuse: 1, blocked: 1, skip: 1, calls: 1, prices: [], unknownCalls: 1 },
  }
  const approval: Extract<AgentItem, { type: 'approval' }> = {
    id: 'batch-approval',
    type: 'approval',
    tool: 'run_storyboard',
    reason: '批量生成分镜图',
    ids: [],
    status: 'pending',
    storyboardBatch: plan,
    at: Date.now(),
  }
  prime(approval)
  let decisions = 0
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/batch-approval'
    ) {
      decisions++
      return request.json().then((body) => {
        expect(body).toEqual({ allow: true })
        return decisions === 1
          ? Response.json({ message: '批量确认暂时失败' }, { status: 503 })
          : new Response(null, { status: 204 })
      })
    }
  })
  const view = renderApp(<Transcript items={[approval]} running={false} intro="" worker="小满" />)
  await view.user.click(screen.getByText('审阅本次批量清单'))
  expect(screen.getByLabelText('清单汇总').textContent).toContain(
    '生成 1 项 · 沿用 1 项 · 阻塞 1 项 · 跳过 1 项',
  )
  expect(screen.getByRole('table').textContent).toContain('待取回镜头')
  expect(screen.getByText(/1 次价格未知/)).toBeTruthy()
  await view.user.click(screen.getByText('查看实际输入'))
  expect(screen.getByText('冻结输入：天台逆光近景')).toBeTruthy()
  expect(screen.getByText('Mock 图片')).toBeTruthy()
  await view.user.click(screen.getByText('生效参数与参考顺序'))
  expect(screen.getByText(/9:16/)).toBeTruthy()
  await view.user.click(screen.getByRole('button', { name: '允许' }))
  await waitFor(() => expect(useAgent.getState().error).toBe('批量确认暂时失败'))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '允许' }).disabled).toBe(false)
  await view.user.click(screen.getByRole('button', { name: '允许' }))
  await waitFor(() => expect(useAgent.getState().pendingActions).toEqual({}))
  expect(decisions).toBe(2)
  view.rerender(
    <Transcript
      items={[{ ...approval, status: 'approved' }]}
      running={false}
      intro=""
      worker="小满"
    />,
  )
  expect(screen.queryByRole('button', { name: '允许' })).toBeNull()
  expect(screen.getByLabelText('清单汇总').textContent).toContain('生成 1 项')
})
