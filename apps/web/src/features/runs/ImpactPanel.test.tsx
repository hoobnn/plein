// @vitest-environment happy-dom
import { createElement, deleteElements, setParam, updateElement } from '@plein/doc'
import type { ImpactDecision, ImpactReport } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, within } from '../../testing/render'
import { expandShots, expandedNodes, planDiffs } from '../storyboard/model'
import { storyboardFixture } from '../storyboard/testing'
import { ImpactPanel } from './ImpactPanel'

const decision: ImpactDecision = {
  id: 'decision',
  nodeId: 'image',
  resultId: 'result',
  inputHash: 'current',
  causes: [{ kind: 'prompt', label: '提示词变化' }],
  createdAt: 1,
}
const report = (name = '镜头图', kept = false): ImpactReport => ({
  nodes: [
    {
      nodeId: 'image',
      name,
      nodeType: 'plein/image',
      impact: 'direct',
      suggest: 'rerun',
      inputHash: 'current',
      causes: decision.causes,
      ...(kept ? { kept: decision } : {}),
    },
  ],
  decisions: kept ? [decision] : [],
  plan: [],
  sequence: [],
  summary: {
    direct: 1,
    indirect: 0,
    cached: 0,
    pending: kept ? 0 : 1,
    kept: kept ? 1 : 0,
    cost: { amount: 0, unknown: 1 },
  },
})

async function setup() {
  vi.useFakeTimers()
  const f = storyboardFixture({ count: 1 })
  useCanvas.setState({ storyboard: null, impact: true })
  const pending: Array<{ request: Request; resolve(response: Response): void }> = []
  mockFetch((request) => {
    if (new URL(request.url).pathname.startsWith('/api/canvases/canvas/impact'))
      return new Promise<Response>((resolve) => pending.push({ request, resolve }))
  })
  const app = renderApp(<ImpactPanel />)
  await act(async () => {})
  const reply = async (index: number, body: unknown, status = 200) => {
    await act(async () => {})
    await act(async () => {
      pending[index]!.resolve(
        status === 204 ? new Response(null, { status }) : Response.json(body, { status }),
      )
    })
  }
  const changed = () =>
    act(() => {
      updateElement(f.doc, f.board, { name: `更新${pending.length}` })
      f.flush()
    })
  const advance = () => act(() => vi.advanceTimersByTimeAsync(800))
  return { ...f, ...app, pending, reply, changed, advance }
}

it.each([false, true])('过期失败=%s 的分析响应不覆盖当前报告与手动勾选', async (failed) => {
  const f = await setup()
  expect(screen.getByRole('status').textContent).toBe('正在分析…')
  expect(f.pending).toHaveLength(1)
  f.changed()
  await f.advance()
  expect(f.pending).toHaveLength(2)
  await f.reply(1, report('新分析'))
  const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: '重做新分析' })
  expect(checkbox.checked).toBe(true)
  await f.user.click(checkbox)
  await f.reply(0, failed ? { message: '过期请求失败' } : report('旧分析'), failed ? 503 : 200)
  expect(checkbox.checked).toBe(false)
  expect(screen.queryByText('旧分析')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('刷新失败禁止按旧报告执行，重新分析后恢复操作并保留选择', async () => {
  const f = await setup()
  await f.reply(0, report())
  f.changed()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '重做选中的 1 个' }).disabled).toBe(
    true,
  )
  await f.advance()
  await f.reply(1, { message: '分析暂不可用' }, 503)
  expect(screen.getByRole('alert').textContent).toContain('分析暂不可用')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保留' }).disabled).toBe(true)
  await f.user.click(screen.getByRole('button', { name: '重新分析' }))
  expect(f.pending).toHaveLength(3)
  await f.reply(2, report())
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '重做选中的 1 个' }).disabled).toBe(
    false,
  )
})

it('撤销保留同帧双击只提交一次，等待时禁用操作，失败后可重试', async () => {
  const f = await setup()
  await f.reply(0, report('镜头图', true))
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '撤销保留' })
  await act(async () => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(f.pending).toHaveLength(2)
  expect(f.pending[1]!.request.method).toBe('DELETE')
  expect(button.disabled).toBe(true)
  expect(screen.getByRole('status').textContent).toContain('正在更新保留决定')
  expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
  await f.reply(1, { message: '撤销暂时失败' }, 503)
  expect(useCanvas.getState().notice).toBe('撤销暂时失败')
  await f.reply(2, report('镜头图', true))
  await f.user.click(button)
  expect(f.pending).toHaveLength(4)
  await f.reply(3, null, 204)
  await f.reply(4, report())
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保留' }).disabled).toBe(false)
  expect(f.pending.filter((p) => p.request.method === 'DELETE')).toHaveLength(2)
})

it.each([false, true])(
  '关闭重开后旧保留失败=%s，只刷新真实成功决定，不打断新面板选择',
  async (failed) => {
    const f = await setup()
    await f.reply(0, report())
    await f.user.click(screen.getByRole('button', { name: '保留' }))
    expect(await f.pending[1]!.request.clone().json()).toEqual({
      nodes: [{ nodeId: 'image', inputHash: 'current' }],
    })
    act(() => useCanvas.getState().toggleImpact(false))
    act(() => useCanvas.getState().toggleImpact(true))
    await f.reply(2, report())
    await f.user.click(screen.getByRole('checkbox'))
    await f.reply(1, failed ? { message: '旧面板保留失败' } : [decision], failed ? 503 : 201)
    expect(useCanvas.getState().notice).toBeNull()
    if (failed) {
      expect(f.pending).toHaveLength(3)
      expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
    } else {
      expect(f.pending).toHaveLength(4)
      await f.reply(3, report('镜头图', true))
      expect(screen.getByRole('button', { name: '撤销保留' })).toBeDefined()
    }
  },
)

it.each([false, true])('切换画布后旧保留失败=%s 不提示或重查旧画布', async (failed) => {
  const f = await setup()
  await f.reply(0, report())
  await f.user.click(screen.getByRole('button', { name: '保留' }))
  act(() => useCanvas.setState({ canvasId: 'other', impact: false }))
  await f.reply(1, failed ? { message: '旧画布失败' } : [decision], failed ? 503 : 201)
  expect(useCanvas.getState().notice).toBeNull()
  expect(f.pending).toHaveLength(2)
})

it('报告节点同帧删除后定位不关闭面板，提示并重新分析', async () => {
  const f = await setup()
  const id = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/image',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const r = report()
  r.nodes[0]!.nodeId = id
  await f.reply(0, r)
  deleteElements(f.doc, [id])
  await f.user.click(screen.getByRole('button', { name: '镜头图' }))
  expect(useCanvas.getState().notice).toContain('节点已被删除')
  expect(f.engine.selection.set).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: '查看影响' })).toBeDefined()
  await f.reply(1, { ...r, nodes: [] })
  expect(screen.getByText('没有受影响的结果')).toBeDefined()
})

it('定位存在节点关闭面板，并把正确对象交给真实导航边界', async () => {
  const f = await setup()
  const r = report()
  r.nodes[0]!.nodeId = f.board
  await f.reply(0, r)
  await f.user.click(screen.getByRole('button', { name: '镜头图' }))
  expect(useCanvas.getState().impact).toBe(false)
  expect(f.engine.selection.set).toHaveBeenCalledWith([f.board])
  expect(f.engine.zoomToFit).toHaveBeenCalledWith([f.board])
})

it('混合币种分别展示，取消选择后估算即时更新', async () => {
  const f = await setup()
  const r = report()
  r.nodes = [
    { ...r.nodes[0]!, nodeId: 'cny', name: '人民币镜头', price: { amount: 2, currency: 'CNY' } },
    { ...r.nodes[0]!, nodeId: 'usd', name: '美元镜头', price: { amount: 3, currency: 'USD' } },
  ]
  await f.reply(0, r)
  expect(screen.getByRole('status').textContent).toContain('预估 2.00 CNY + 3.00 USD')
  await f.user.click(screen.getByRole('checkbox', { name: '重做美元镜头' }))
  expect(screen.getByRole('status').textContent).toContain('预估 2.00 CNY')
  expect(screen.getByRole('status').textContent).not.toContain('USD')
})

it.each([false, true])(
  '仅计划差异仍显示入口；同名=%s 的来源与同步范围保持隔离',
  async (sameName) => {
    const f = storyboardFixture({ count: 1, expanded: true })
    const other = createElement(f.doc, {
      kind: 'node',
      nodeType: 'plein/storyboard',
      name: sameName ? '分镜测试' : '另一份分镜',
      params: { shots: f.read() },
      x: 0,
      y: 500,
      w: 300,
      h: 200,
    })
    expandShots(f.engine, other, ['shot-1'], f.catalog)
    for (const id of [f.board, other])
      setParam(
        f.doc,
        id,
        'shots',
        f.read().map((s) => ({ ...s, imagePrompt: `计划${id}` })),
      )
    f.flush()
    const image = (board: string) =>
      expandedNodes(f.engine, board)
        .get('shot-1')!
        .find((n) => (n.params!.source as { role: string }).role === 'image')!
    const original = [f.board, other].map((id) => image(id).params!.prompt)
    useCanvas.setState({ storyboard: null, impact: true })
    mockFetch((request) => {
      if (
        request.method === 'GET' &&
        new URL(request.url).pathname === '/api/canvases/canvas/impact'
      ) {
        const r = report()
        r.nodes = []
        r.plan = [f.board, other].flatMap((id) =>
          planDiffs(f.engine, id).size
            ? [{ storyboard: id, shot: 'shot-1', no: 1, fields: 1 }]
            : [],
        )
        return Response.json(r)
      }
    })
    const { user } = renderApp(<ImpactPanel />)
    const ids = [f.board, other].sort()
    const target = sameName ? ids[1]! : other
    const label = sameName ? '分镜测试（同名 2）' : '另一份分镜'
    const row = await screen.findByRole('listitem', { name: `${label} · 镜头 01` })
    expect(screen.queryByText('没有受影响的结果')).toBeNull()
    const button = within(row).getByRole('button', { name: '查看差异' })
    expect(
      document.getElementById(button.getAttribute('aria-describedby')!)!.textContent,
    ).toContain(label)
    await user.click(button)
    expect(screen.getByTestId('storyboard-source').textContent).toBe(`分镜：${label}`)
    act(() => {
      updateElement(f.doc, target, { name: '重新命名的分镜' })
      f.flush()
    })
    expect(screen.getByTestId('storyboard-source').textContent).toBe('分镜：重新命名的分镜')
    await user.click(
      screen.getByRole('button', { name: sameName ? '不同步，按节点现状' : '同步计划改动' }),
    )
    expect(screen.getByText('没有待处理的差异')).toBeDefined()
    for (const [i, id] of [f.board, other].entries())
      expect(image(id).params!.prompt).toBe(
        !sameName && id === target ? `计划${id} 景别：中景` : original[i],
      )
    expect(planDiffs(f.engine, target).size).toBe(0)
    expect(
      planDiffs(
        f.engine,
        [f.board, other].find((id) => id !== target)!,
      ).size,
    ).toBe(1)
  },
)
