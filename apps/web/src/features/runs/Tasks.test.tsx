// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { Selection } from '@plein/canvas-core'
import { createElement, createDoc, deleteElements, type PleinDoc } from '@plein/doc'
import type { BatchItem, GroupInfo, JobInfo, JobList } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { queryClient } from '../../api/query'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
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
import { useCancelRequests } from './cancelRequests'
import { useRecoveryRequests } from './recoveryRequests'
import { useRunRequests } from './runRequests'
import { Tasks } from './Tasks'

resetStoreAfterEach(useCancelRequests)
resetStoreAfterEach(useRunRequests)
resetStoreAfterEach(useRecoveryRequests)

const CANVAS = 'canvas-1'
const JOBS_PATH = `/api/canvases/${CANVAS}/jobs`

/** 真实文档 + 桩化引擎：任务面板只读文档与选区，不碰渲染 */
function makeEngine() {
  const doc = createDoc(undefined, { schedule: (flush) => flush() })
  const selection = new Selection()
  const zoomToFit = vi.fn()
  const engine = {
    doc,
    selection,
    zoomToFit,
    onStateChange: () => () => {},
    onMenu: () => () => {},
    onArrange: () => () => {},
    state: {
      tool: 'select',
      zoom: 1,
      selection: 0,
      canUndo: false,
      canRedo: false,
      edgesHidden: false,
    },
  } as unknown as Engine
  return { engine, doc, selection, zoomToFit }
}

const addNode = (doc: PleinDoc, id: string, name: string, run?: object) => {
  const created = createElement(doc, {
    kind: 'node',
    id,
    nodeType: 'plein/image',
    nodeVersion: 1,
    name,
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    ports: { inputs: [], outputs: [] },
  })
  if (created !== id) throw new Error('节点 id 冲突')
  if (run) doc.mutable(id)!.set('run', run)
  return id
}

const job = (over: Partial<JobInfo> = {}): JobInfo => ({
  id: 'job-1',
  nodeId: 'node-1',
  nodeType: 'plein/image',
  status: 'failed',
  attempts: 1,
  createdAt: 1,
  ...over,
})

const group = (over: Partial<GroupInfo> = {}): GroupInfo => ({
  id: 'group-1',
  frameId: 'frame-1',
  scope: 'frame',
  status: 'done',
  total: 1,
  createdAt: 1,
  finishedAt: 2,
  summary: { succeeded: 1, cached: 0, failed: 0, canceled: 0, skipped: 0 },
  ...over,
})

interface Harness {
  fetch: ReturnType<typeof mockFetch>
  state: { list: JobList }
  doc: PleinDoc
  selection: Selection
  zoomToFit: ReturnType<typeof vi.fn>
  user: ReturnType<typeof renderApp>['user']
  reopen(): void
}

/** 渲染打开的任务面板；jobs 路由按 state 回放，其余路由按需注入。同步返回，避免路由闭包读到未赋值的 f */
function setup(
  list: JobList,
  routes: Record<
    string,
    (request: Request, url: URL) => Response | Promise<Response> | undefined
  > = {},
  docNodes: Array<{ name: string; run?: object }> = [{ name: '任务目标原名' }],
): Harness {
  const { engine, doc, selection, zoomToFit } = makeEngine()
  for (const [index, node] of docNodes.entries())
    addNode(doc, `node-${index + 1}`, node.name, node.run)
  const state = { list }
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    const route = routes[`${request.method} ${url.pathname}`]
    if (route) return route(request, url)
    if (request.method === 'GET' && url.pathname === JOBS_PATH) return Response.json(state.list)
    if (request.method === 'GET' && url.pathname === '/api/runs/groups/group-1/items')
      return Response.json(
        state.list.groups[0] && {
          nodeId: docNodes[0]!.name === '' ? '' : 'node-1',
          seq: 0,
          stage: 'run' as const,
          deps: [],
          outcome: 'succeeded' as const,
          updatedAt: 1,
        }
          ? [batchItem()]
          : [],
      )
  })
  useCanvas.setState({ engine, canvasId: CANVAS, tasks: true })
  const rendered = renderApp(<Tasks />)
  return {
    fetch,
    state,
    doc,
    selection,
    zoomToFit,
    user: rendered.user,
    reopen: () => useCanvas.setState({ tasks: true }),
  }
}

const batchItem = (over: Partial<BatchItem> = {}): BatchItem => ({
  nodeId: 'node-1',
  seq: 0,
  stage: 'run',
  deps: [],
  outcome: 'succeeded',
  updatedAt: 1,
  ...over,
})

const callsOf = (fetch: ReturnType<typeof mockFetch>, method: string, path: string) =>
  fetch.mock.calls.filter(([input, init]) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url, location.href)
    return (init?.method ?? 'GET') === method && url.pathname === path
  })

/** 最小目录：节点被删后行名退到节点标题，而不是裸类型名 */
const minimalCatalog = {
  plugins: [],
  nodes: [{ type: 'plein/image', title: '生成图片', version: 1, executable: true }],
  providers: [],
  defaultModels: {},
  templates: [],
  prompts: [],
  elements: [],
} as unknown as ReturnType<typeof useCatalog.getState>['catalog']

const panel = () => screen.getByRole('complementary', { name: '任务' })

beforeEach(() => {
  // 面板自带轮询；组件测试只验证读取与重试，不让间隔请求漏出用例
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, refetchInterval: false },
  })
})

it('首次读取失败可直接重试，等待时关闭重开不重复读取', async () => {
  let phase: 'fail' | 'hold' | 'okay' = 'fail'
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  const f = setup(
    { jobs: [], groups: [] },
    {
      [`GET ${JOBS_PATH}`]: () => {
        requests++
        if (phase === 'fail') return Response.json({ message: '任务列表测试失败' }, { status: 503 })
        if (phase === 'hold') return held.then(() => Response.json(f.state.list))
        return Response.json(f.state.list)
      },
    },
  )
  expect(await within(panel()).findByText('读取任务失败：任务列表测试失败')).toBeTruthy()
  expect(within(panel()).queryByText('还没有运行过节点')).toBeNull()
  phase = 'hold'
  const retry = within(panel()).getByRole('button', { name: '重新读取' })
  retry.click()
  retry.click()
  await waitFor(() => expect(requests).toBe(2))
  const refresh = within(panel()).getByRole('button', { name: '刷新任务' })
  expect((refresh as HTMLButtonElement).disabled).toBe(true)
  expect(within(panel()).getByRole('status').textContent).toBe('加载任务中…')
  useCanvas.setState({ tasks: false })
  f.reopen()
  expect(
    (within(panel()).getByRole('button', { name: '刷新任务' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  phase = 'okay'
  await act(async () => release())
  await waitFor(() => expect(within(panel()).getByText('还没有运行过节点')).toBeTruthy())
  expect(within(panel()).queryByRole('alert')).toBeNull()
  expect(requests).toBe(2)
})

it('已有任务刷新失败保留旧列表并说明状态未更新，重试后展示最新', async () => {
  let phase: 'okay' | 'fail' = 'okay'
  const f = setup(
    { jobs: [job({ id: 'jobs-read', status: 'queued' })], groups: [] },
    {
      [`GET ${JOBS_PATH}`]: () => {
        if (phase === 'fail') return Response.json({ message: '任务刷新测试失败' }, { status: 503 })
        return Response.json(f.state.list)
      },
    },
  )
  const row = await within(panel()).findByRole('button', { name: '任务目标原名' })
  expect(row).toBeTruthy()
  phase = 'fail'
  useCanvas.setState({ tasks: false })
  f.reopen()
  const error = await within(panel()).findByRole('alert')
  expect(error.textContent).toContain('刷新任务失败')
  expect(error.textContent).toContain('以下仍为上次读取的任务状态')
  expect(within(panel()).getByRole('button', { name: '任务目标原名' })).toBeTruthy()
  f.state.list = { jobs: [job({ id: 'jobs-read', status: 'succeeded' })], groups: [] }
  phase = 'okay'
  within(error).getByRole('button', { name: '重新读取' }).click()
  await waitFor(() => expect(within(panel()).getByText('已完成')).toBeTruthy())
  expect(within(panel()).queryByRole('alert')).toBeNull()
})

it('恢复操作按状态分流：明确失败才重试，可取回的重新获取，其余标记已处理', async () => {
  const f = setup(
    { jobs: [job({ recovery: { state: 'remote_failed' } })], groups: [] },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: () => Response.json(job()),
      [`POST /api/canvases/${CANVAS}/nodes/node-1/run`]: () =>
        Response.json({ runId: 'rerun' }, { status: 202 }),
    },
  )
  await within(panel()).findByRole('button', { name: '任务目标原名' })
  // remote_failed：直接重新生成，不走恢复接口
  within(panel()).getByRole('button', { name: '重试' }).click()
  await waitFor(() =>
    expect(callsOf(f.fetch, 'POST', `/api/canvases/${CANVAS}/nodes/node-1/run`)).toHaveLength(1),
  )
  expect(callsOf(f.fetch, 'POST', `${JOBS_PATH}/job-1/recover`)).toHaveLength(0)
})

it.each([
  ['fetch_failed 可重新获取', { state: 'fetch_failed', refetchable: true } as const, '重新获取'],
  [
    'remote_pending 只能标记已处理',
    { state: 'remote_pending', refetchable: false } as const,
    '标记已处理',
  ],
] as const)('%s', async (_, recovery, action) => {
  const f = setup(
    { jobs: [job({ recovery })], groups: [] },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: async (request) => {
        // 按动作返回结果：refetch 后平台已受理；dismiss 后恢复提示整体收起
        const body = (await request.json()) as { action: string }
        if (body.action === 'refetch') {
          const recovered = job({ recovery: { state: 'remote_pending', refetchable: true } })
          f.state.list = { jobs: [recovered], groups: [] }
          return Response.json(recovered)
        }
        const dismissed = job({ recovery: { ...recovery, dismissed: true } })
        f.state.list = { jobs: [dismissed], groups: [] }
        return Response.json(dismissed)
      },
    },
  )
  await within(panel()).findByRole('button', { name: '任务目标原名' })
  expect(within(panel()).queryByRole('button', { name: '重试' })).toBeNull()
  within(panel()).getByRole('button', { name: action }).click()
  const bodies = () =>
    f.fetch.mock.calls
      .filter(([input, init]) => {
        const url = new URL(
          typeof input === 'string' ? input : (input as Request).url,
          location.href,
        )
        return init?.method === 'POST' && url.pathname === `${JOBS_PATH}/job-1/recover`
      })
      .map(([, init]) => JSON.parse(String(init!.body)))
  // 请求体必须与按钮的动作一致，而不是随便发一个恢复请求
  await waitFor(() =>
    expect(bodies()).toEqual([{ action: action === '重新获取' ? 'refetch' : 'dismiss' }]),
  )
  if (action === '重新获取')
    await waitFor(() => expect(within(panel()).getByText('平台已受理，结果尚未取回')).toBeTruthy())
  else
    // 标记已处理后恢复提示收起，只剩状态行
    await waitFor(() => expect(within(panel()).queryByTestId('job-recovery')).toBeNull())
  // 两种恢复动作都不触发重新生成
  expect(callsOf(f.fetch, 'POST', `/api/canvases/${CANVAS}/nodes/node-1/run`)).toHaveLength(0)
})

it('填平台任务 ID 续查：失败保留输入，成功清理表单', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = setup(
    {
      jobs: [
        job({
          recovery: {
            state: 'submit_unknown',
            provider: '测试平台',
            attachable: true,
            refetchable: false,
          },
        }),
      ],
      groups: [],
    },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: () => {
        calls++
        return calls === 1
          ? Response.json({ message: '恢复服务暂不可用，请重试' }, { status: 503 })
          : held
      },
    },
  )
  await within(panel()).findByTestId('job-recovery')
  within(panel()).getByRole('button', { name: '填写平台任务 ID' }).click()
  const input = await within(panel()).findByRole<HTMLInputElement>('textbox', {
    name: '平台任务 ID',
  })
  await f.user.type(input, '  remote-existing-42  ')
  within(panel()).getByRole('button', { name: '接着取结果' }).click()
  expect(await within(panel()).findByRole('alert')).toBeTruthy()
  expect(within(panel()).getByRole('alert').textContent).toBe('恢复服务暂不可用，请重试')
  expect(input.value).toBe('  remote-existing-42  ')
  within(panel()).getByRole('button', { name: '接着取结果' }).click()
  await waitFor(() => expect(calls).toBe(2))
  expect(
    (within(panel()).getByRole('button', { name: '接着取结果' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  f.state.list = {
    jobs: [
      job({
        recovery: { state: 'remote_pending', refetchable: true, remoteId: 'remote-existing-42' },
      }),
    ],
    groups: [],
  }
  await act(async () => release(Response.json(job())))
  await waitFor(() =>
    expect(within(panel()).getByRole('button', { name: '重新获取' })).toBeTruthy(),
  )
  expect(within(panel()).queryByRole('textbox', { name: '平台任务 ID' })).toBeNull()
  expect(within(panel()).queryByRole('alert')).toBeNull()
  const bodies = f.fetch.mock.calls
    .filter(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url, location.href)
      return init?.method === 'POST' && url.pathname === `${JOBS_PATH}/job-1/recover`
    })
    .map(([, init]) => JSON.parse(String(init!.body)))
  expect(bodies).toEqual([
    { action: 'attach', remoteId: 'remote-existing-42' },
    { action: 'attach', remoteId: 'remote-existing-42' },
  ])
  expect(callsOf(f.fetch, 'POST', `/api/canvases/${CANVAS}/nodes/node-1/run`)).toHaveLength(0)
})

it('重新提交确认：取消只退回入口，确认失败可重试', async () => {
  let fail = true
  const f = setup(
    {
      jobs: [job({ recovery: { state: 'submit_unknown', attachable: false, refetchable: false } })],
      groups: [],
    },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: () =>
        fail
          ? Response.json({ message: '重新提交测试失败' }, { status: 503 })
          : Response.json(job({ recovery: { state: 'remote_pending', refetchable: true } })),
    },
  )
  await within(panel()).findByTestId('job-recovery')
  const trigger = within(panel()).getByRole('button', { name: '确认未受理，重新提交' })
  trigger.click()
  const confirm = await within(panel()).findByRole('group', { name: '重新提交确认' })
  expect(within(confirm).getByRole('button', { name: '取消' })).toBeTruthy()
  fireEvent.keyDown(confirm, { key: 'Escape' })
  await waitFor(() =>
    expect(within(panel()).queryByRole('group', { name: '重新提交确认' })).toBeNull(),
  )
  expect((document.activeElement as HTMLElement)?.textContent).toContain('确认未受理，重新提交')
  // 入口在确认框收起后重新挂载，重新查询
  within(panel()).getByRole('button', { name: '确认未受理，重新提交' }).click()
  await within(panel()).findByRole('group', { name: '重新提交确认' })
  within(panel()).getByRole('button', { name: '重新提交' }).click()
  expect(await within(panel()).findByRole('alert')).toBeTruthy()
  expect(within(panel()).getByRole('alert').textContent).toBe('重新提交测试失败')
  fail = false
  f.state.list = {
    jobs: [job({ recovery: { state: 'remote_pending', refetchable: true } })],
    groups: [],
  }
  within(panel()).getByRole('button', { name: '重新提交' }).click()
  await waitFor(() =>
    expect(within(panel()).getByRole('button', { name: '重新获取' })).toBeTruthy(),
  )
})

it('原 Key 失效：保留重新获取和标记已处理，当前组重提必须二次确认', async () => {
  const bodies: unknown[] = []
  const f = setup(
    {
      jobs: [
        job({
          recovery: {
            state: 'remote_pending',
            refetchable: true,
            credentialLost: { reason: 'missing' },
            credentialLabel: '默认',
            currentCredentialLabel: '团队',
          },
        }),
      ],
      groups: [],
    },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: async (request) => {
        bodies.push(await request.json())
        return Response.json(job())
      },
    },
  )
  await within(panel()).findByTestId('job-recovery')
  expect(within(panel()).getByRole('button', { name: '重新获取' })).toBeTruthy()
  expect(within(panel()).getByRole('button', { name: '标记已处理' })).toBeTruthy()
  await f.user.click(within(panel()).getByRole('button', { name: '用当前 Key 重新提交' }))
  const confirm = await within(panel()).findByRole('group', { name: '重新提交确认' })
  expect(confirm.textContent).toContain(
    '原来的 Key「默认」已删除，无法取回之前的结果。用当前 Key「团队」重新提交会再次计费。确定吗？',
  )
  expect(bodies).toEqual([])
  await f.user.click(within(confirm).getByRole('button', { name: '重新提交' }))
  await waitFor(() => expect(bodies).toEqual([{ action: 'resubmit' }]))
})

it('配音音色所属 Key 失效时不提供重提，只提示换音色并允许标记已处理', async () => {
  setup({
    jobs: [
      job({
        recovery: {
          state: 'remote_pending',
          refetchable: true,
          credentialLost: { reason: 'missing', voice: '旁白' },
        },
      }),
    ],
    groups: [],
  })
  const recovery = await within(panel()).findByTestId('job-recovery')
  expect(recovery.textContent).toContain(
    '音色「旁白」所属的 Key 已删除，请在节点上改用其他音色，或重新复刻后再运行。',
  )
  expect(within(recovery).queryByRole('button', { name: '用当前 Key 重新提交' })).toBeNull()
  expect(within(recovery).queryByRole('button', { name: '确认未受理，重新提交' })).toBeNull()
  expect(within(recovery).getByRole('button', { name: '标记已处理' })).toBeTruthy()
})

it('恢复请求迟到失败不通知别的画布，回来后仍可重试', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = setup(
    {
      jobs: [job({ recovery: { state: 'fetch_failed', refetchable: true, remoteId: 'r' } })],
      groups: [],
    },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: () => {
        calls++
        if (calls === 1) return held
        const recovered = job({ recovery: { state: 'remote_pending', refetchable: true } })
        f.state.list = { jobs: [recovered], groups: [] }
        return Response.json(recovered)
      },
      'GET /api/canvases/other-canvas/jobs': () => Response.json({ jobs: [], groups: [] }),
    },
  )
  await within(panel()).findByTestId('job-recovery')
  within(panel()).getByRole('button', { name: '重新获取' }).click()
  await waitFor(() => expect(calls).toBe(1))
  // 请求进行中切到别的画布：迟到失败只更新面板数据，不再弹全局提示
  useCanvas.setState({ canvasId: 'other-canvas' })
  await act(async () =>
    release(Response.json({ message: '原画布恢复服务暂不可用' }, { status: 503 })),
  )
  expect(useCanvas.getState().notice).toBeNull()
  useCanvas.setState({ canvasId: CANVAS })
  await within(panel()).findByRole('button', { name: '重新获取' })
  within(panel()).getByRole('button', { name: '重新获取' }).click()
  await waitFor(() => expect(within(panel()).getByText('平台已受理，结果尚未取回')).toBeTruthy())
  expect(calls).toBe(2)
})

it('恢复请求等待中重开面板共享禁用状态，失败后可重试', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = setup(
    { jobs: [job({ recovery: { state: 'fetch_failed', refetchable: true } })], groups: [] },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: () => {
        calls++
        if (calls === 1) return held
        const recovered = job({ recovery: { state: 'remote_pending', refetchable: true } })
        f.state.list = { jobs: [recovered], groups: [] }
        return Response.json(recovered)
      },
    },
  )
  await within(panel()).findByTestId('job-recovery')
  const refetch = within(panel()).getByRole('button', { name: '重新获取' })
  refetch.click()
  await waitFor(() => expect(calls).toBe(1))
  useCanvas.setState({ tasks: false })
  f.reopen()
  const reopened = within(panel()).getByRole('button', { name: '重新获取' })
  expect((reopened as HTMLButtonElement).disabled).toBe(true)
  expect(within(panel()).getByRole('status').textContent).toContain('正在处理恢复请求…')
  await act(async () => release(Response.json({ message: '恢复请求暂时失败' }, { status: 503 })))
  await waitFor(() => expect((reopened as HTMLButtonElement).disabled).toBe(false))
  reopened.click()
  await waitFor(() => expect(within(panel()).getByText('平台已受理，结果尚未取回')).toBeTruthy())
  expect(calls).toBe(2)
})

it('停止请求带运行身份；服务端拒绝过期身份时提示原因', async () => {
  const f = setup(
    { jobs: [job({ id: 'old-job', status: 'running' })], groups: [] },
    {
      [`POST /api/canvases/${CANVAS}/nodes/node-1/cancel`]: () =>
        Response.json({ message: '此节点已开始其他任务，旧停止请求未执行' }, { status: 409 }),
    },
    [{ name: '任务目标原名', run: { id: 'new-job', status: 'running', at: 1 } }],
  )
  await within(panel()).findByRole('button', { name: '任务目标原名' })
  within(panel()).getByRole('button', { name: '停止' }).click()
  await waitFor(() =>
    expect(useCanvas.getState().notice).toBe('此节点已开始其他任务，旧停止请求未执行'),
  )
  const bodies = f.fetch.mock.calls
    .filter(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url, location.href)
      return (
        init?.method === 'POST' && url.pathname === `/api/canvases/${CANVAS}/nodes/node-1/cancel`
      )
    })
    .map(([, init]) => JSON.parse(String(init!.body)))
  expect(bodies).toEqual([{ runId: 'old-job' }])
})

it('停止等待中重开面板仍显示等待，失败可重试且不重复提交', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = setup(
    { jobs: [job({ status: 'running' })], groups: [] },
    {
      [`POST /api/canvases/${CANVAS}/nodes/node-1/cancel`]: () => {
        calls++
        if (calls === 1)
          return held.then(() => Response.json({ message: '停止任务测试失败' }, { status: 503 }))
        return new Response(null, { status: 204 })
      },
    },
  )
  const stop = await within(panel()).findByRole('button', { name: '停止' })
  act(() => {
    stop.click()
    stop.click()
  })
  await waitFor(() => expect(calls).toBe(1))
  expect((stop as HTMLButtonElement).disabled).toBe(true)
  useCanvas.setState({ tasks: false })
  f.reopen()
  const reopened = within(panel()).getByRole('button', { name: '停止' })
  expect((reopened as HTMLButtonElement).disabled).toBe(true)
  await waitFor(() => expect(within(panel()).getByText('正在停止任务…')).toBeTruthy())
  await act(async () => release())
  await waitFor(() => expect(useCanvas.getState().notice).toBe('停止任务测试失败'))
  reopened.click()
  await waitFor(() =>
    expect(callsOf(f.fetch, 'POST', `/api/canvases/${CANVAS}/nodes/node-1/cancel`)).toHaveLength(2),
  )
})

it('任务目标随文档改名与删除立即同步操作入口', async () => {
  useCatalog.setState({ catalog: minimalCatalog })
  const f = setup({ jobs: [job()], groups: [] })
  const node = [...f.doc.elements()][0]!
  const row = await within(panel()).findByRole('button', { name: '任务目标原名' })
  expect((row as HTMLButtonElement).disabled).toBe(false)
  expect(within(panel()).getByRole('button', { name: '重试' })).toBeTruthy()
  act(() => {
    f.doc.mutable(node.id)!.set('name', '协作后的新名字')
  })
  await waitFor(() =>
    expect(within(panel()).getByRole('button', { name: '协作后的新名字' })).toBeTruthy(),
  )
  act(() => {
    deleteElements(f.doc, [node.id])
  })
  // 文档里没有这个名字了，行名退到节点标题，按钮停用并说明节点已删除
  await waitFor(() => {
    const deleted = within(panel()).getByRole('button', { name: '生成图片' })
    expect((deleted as HTMLButtonElement).disabled).toBe(true)
    expect(deleted.getAttribute('title')).toBe('节点已删除')
  })
  expect(within(panel()).queryByRole('button', { name: '重试' })).toBeNull()
})

it('批次记录可展开收开，定位目标随文档删除禁用', async () => {
  const { engine, doc, selection } = makeEngine()
  createElement(doc, {
    kind: 'frame',
    id: 'frame-1',
    name: '分组边界',
    x: 0,
    y: 0,
    w: 400,
    h: 400,
  })
  addNode(doc, 'node-1', '批量定位水杯')
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === JOBS_PATH)
      return Response.json({ jobs: [], groups: [group()] })
    if (request.method === 'GET' && url.pathname === '/api/runs/groups/group-1/items')
      return Response.json([batchItem()])
  })
  useCanvas.setState({ engine, canvasId: CANVAS, tasks: true })
  renderApp(<Tasks />)
  void fetch
  await within(panel()).findByRole('heading', { name: '批量运行' })
  const frameButton = within(panel()).getByRole('button', { name: '分组边界' })
  expect((frameButton as HTMLButtonElement).disabled).toBe(false)
  const toggle = within(panel()).getByRole('button', { name: '批次记录' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  toggle.click()
  const records = await within(panel()).findByRole('list', { name: '批次记录' })
  const item = within(records).getByRole('button', { name: '批量定位水杯' })
  expect((item as HTMLButtonElement).disabled).toBe(false)
  item.click()
  expect(selection.values()).toEqual(['node-1'])
  // 窄屏定位会先收起全宽面板；重新打开继续验证
  await waitFor(() => expect(screen.queryByRole('complementary', { name: '任务' })).toBeNull())
  useCanvas.setState({ tasks: true })
  act(() => {
    deleteElements(doc, ['node-1'])
  })
  // 面板重开后批次记录默认收起，再展开一次
  await within(panel()).findByRole('button', { name: '批次记录' })
  within(panel()).getByRole('button', { name: '批次记录' }).click()
  const itemAfterDelete = () =>
    within(panel())
      .getByRole('list', { name: '批次记录' })
      .querySelectorAll('li button')[0] as HTMLButtonElement
  await waitFor(() => expect(itemAfterDelete().disabled).toBe(true))
  expect(itemAfterDelete().getAttribute('title')).toBe('节点已删除')
  within(panel()).getByRole('button', { name: '收起批次记录' }).click()
  await waitFor(() => expect(within(panel()).queryByRole('list', { name: '批次记录' })).toBeNull())
})

it('重试只对最新一次的失败任务出现，并带上原运行身份', async () => {
  const f = setup(
    {
      jobs: [
        job({ id: 'newer', status: 'succeeded', createdAt: 2 }),
        job({ id: 'older', status: 'failed', createdAt: 1 }),
      ],
      groups: [],
    },
    {
      [`POST /api/canvases/${CANVAS}/nodes/node-1/run`]: () =>
        Response.json({ runId: 'rerun' }, { status: 202 }),
    },
  )
  expect(await within(panel()).findAllByRole('button', { name: '任务目标原名' })).toHaveLength(2)
  // 两条记录都在，但只有节点当前这次（newer 已成功）之后的旧失败不提供重试，并说明原因
  expect(within(panel()).queryByRole('button', { name: '重试' })).toBeNull()
  expect(within(panel()).getByText('失败 · 已有更新的运行')).toBeTruthy()
  f.state.list = {
    jobs: [job({ id: 'latest', status: 'failed', createdAt: 2 })],
    groups: [],
  }
  within(panel()).getByRole('button', { name: '刷新任务' }).click()
  const retry = await within(panel()).findByRole('button', { name: '重试' })
  retry.click()
  await waitFor(() =>
    expect(callsOf(f.fetch, 'POST', `/api/canvases/${CANVAS}/nodes/node-1/run`)).toHaveLength(1),
  )
  const body = JSON.parse(
    String(
      f.fetch.mock.calls.filter(([input, init]) => {
        const url = new URL(
          typeof input === 'string' ? input : (input as Request).url,
          location.href,
        )
        return (
          init?.method === 'POST' && url.pathname === `/api/canvases/${CANVAS}/nodes/node-1/run`
        )
      })[0]![1]!.body,
    ),
  )
  expect(body).toMatchObject({ retryOf: 'latest' })
})

it('重试等待中关闭重开面板仍显示等待，失败后可再次提交', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const f = setup(
    { jobs: [job()], groups: [] },
    {
      [`POST /api/canvases/${CANVAS}/nodes/node-1/run`]: () => {
        calls++
        return calls === 1
          ? held.then(() => Response.json({ message: '重试请求暂不可用' }, { status: 503 }))
          : Response.json({ runId: 'rerun' }, { status: 202 })
      },
    },
  )
  const retry = await within(panel()).findByRole('button', { name: '重试' })
  act(() => {
    retry.click()
    retry.click()
  })
  await waitFor(() => expect(calls).toBe(1))
  expect((retry as HTMLButtonElement).disabled).toBe(true)
  useCanvas.setState({ tasks: false })
  f.reopen()
  const reopened = await within(panel()).findByRole('button', { name: '重试' })
  expect((reopened as HTMLButtonElement).disabled).toBe(true)
  expect(within(panel()).getByRole('status').textContent).toContain('正在提交重试…')
  await act(async () => release())
  await waitFor(() => expect(useCanvas.getState().notice).toBe('重试请求暂不可用'))
  await waitFor(() => expect((reopened as HTMLButtonElement).disabled).toBe(false))
  reopened.click()
  await waitFor(() => expect(calls).toBe(2))
})

it('复制核查信息失败可重试，成功后给出确认', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(() =>
    Promise.reject(new DOMException('denied', 'NotAllowedError')),
  )
  const f = setup({
    jobs: [
      job({
        recovery: { state: 'submit_unknown', provider: '测试平台', attachable: false },
      }),
    ],
    groups: [],
  })
  await within(panel()).findByRole('button', { name: '复制核查信息' })
  expect(within(panel()).queryByRole('button', { name: '填写平台任务 ID' })).toBeNull()
  // 渲染会重装 clipboard 属性：渲染后再替换对象上的方法
  const original = navigator.clipboard.writeText.bind(navigator.clipboard)
  navigator.clipboard.writeText = writeText
  within(panel()).getByRole('button', { name: '复制核查信息' }).click()
  expect(await within(panel()).findByRole('alert')).toBeTruthy()
  expect(within(panel()).getByRole('alert').textContent).toBe('复制核查信息失败，请重试')
  writeText.mockImplementation(() => Promise.resolve())
  within(panel()).getByRole('button', { name: '复制核查信息' }).click()
  await waitFor(() => expect(useCanvas.getState().notice).toBe('核查信息已复制'))
  expect(writeText).toHaveBeenCalledTimes(2)
  // 复制不产生任何提交或恢复请求
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  navigator.clipboard.writeText = original
})

it('平台任务 ID 的组字 Enter 不提交，Escape 分层退出', async () => {
  const f = setup(
    {
      jobs: [job({ recovery: { state: 'submit_unknown', attachable: true, refetchable: false } })],
      groups: [],
    },
    {
      [`POST ${JOBS_PATH}/job-1/recover`]: () =>
        Response.json({ message: '任务 ID 核查测试失败' }, { status: 503 }),
    },
  )
  await within(panel()).findByTestId('job-recovery')
  const attach = within(panel()).getByRole('button', { name: '填写平台任务 ID' })
  attach.click()
  const input = await within(panel()).findByRole<HTMLInputElement>('textbox', {
    name: '平台任务 ID',
  })
  expect(document.activeElement).toBe(input)
  await f.user.type(input, 'remote-keyboard-id')
  for (const composing of [{ keyCode: 229 }, { isComposing: true }])
    fireEvent.keyDown(input, { key: 'Enter', ...composing })
  expect(f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  expect(input.value).toBe('remote-keyboard-id')
  // 第一层 Escape 只收起输入，焦点回到入口
  fireEvent.keyDown(input, { key: 'Escape' })
  await waitFor(() =>
    expect(within(panel()).queryByRole('textbox', { name: '平台任务 ID' })).toBeNull(),
  )
  const reopened = within(panel()).getByRole('button', { name: '填写平台任务 ID' })
  expect(document.activeElement).toBe(reopened)
  // 第二层 Escape 收起面板，焦点回到工具条
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('complementary', { name: '任务' })).toBeNull())
})
