// @vitest-environment happy-dom
import type { AgentItem, AgentSession } from '@plein/protocol'
import type { Engine } from '@plein/canvas-core'
import { createElement, deleteElements } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
} from '../../testing/render'
import { EditPlanRow } from './EditPlanCard'
import { useAgent } from './store'

resetStoreAfterEach(useAgent)

type EditItem = Extract<AgentItem, { type: 'edit_plan' }>

const estimate = {
  calls: 0,
  cached: 0,
  cost: { amount: 0, unknown: 0 },
}

function item(): EditItem {
  return {
    id: 'approval-1',
    type: 'edit_plan',
    status: 'pending',
    at: 1,
    plan: {
      id: 'plan-1',
      canvasId: 'c1',
      summary: '让镜头更紧张',
      targets: [
        {
          nodeId: 'n1',
          name: '天台镜头',
          nodeType: 'plein/image',
          version: 'v1',
          changes: [{ key: 'prompt', label: '提示词', before: '雨夜', after: '压迫感更强' }],
          refs: [],
          issues: [],
        },
      ],
      steps: [
        {
          nodeId: 'n1',
          name: '天台镜头',
          stage: 'image',
          scope: 'images',
          targets: ['n1'],
          causes: [],
          version: 'v1',
        },
      ],
      keep: [],
      untouched: 0,
      estimate: { text: estimate, images: estimate, full: estimate },
      status: 'pending',
      createdAt: 1,
    },
  }
}

function prime() {
  const session: AgentSession = {
    id: 's1',
    canvasId: 'c1',
    agent: 'builtin',
    title: '修改方案',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    items: [item()],
  }
  useAgent.setState({ canvasId: 'c1', session })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('目标变化使方案失效后明确说明旧方案未执行，不再提供批准或编辑入口', () => {
  prime()
  const value = item()
  const view = renderApp(<EditPlanRow item={value} />)
  expect(screen.getByRole('button', { name: '只改文字' })).toBeTruthy()
  view.rerender(
    <EditPlanRow
      item={{ ...value, status: 'approved', plan: { ...value.plan, status: 'stale' } }}
    />,
  )
  expect(screen.getByText('目标在批准前变了，旧方案没有执行：让镜头更紧张')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '只改文字' })).toBeNull()
  expect(screen.queryByRole('button', { name: '只出候选图' })).toBeNull()
  expect(screen.queryByRole('button', { name: '改提示词' })).toBeNull()
})

it('取消逐项编辑恢复入口和原值，可用键盘重新编辑', async () => {
  prime()
  const view = renderApp(<EditPlanRow item={item()} />)
  await view.user.click(screen.getByRole('button', { name: '改提示词' }))
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词改成' })
  await view.user.clear(field)
  await view.user.type(field, '取消内容不能提交')
  await view.user.keyboard('{Escape}')
  expect(screen.queryByRole('textbox', { name: '提示词改成' })).toBeNull()
  const trigger = screen.getByRole('button', { name: '改提示词' })
  expect(trigger).toBe(document.activeElement)
  await view.user.keyboard('{Enter}')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词改成' }).value).toBe(
    '压迫感更强',
  )
  await view.user.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.getByRole('button', { name: '改提示词' })).toBe(document.activeElement)
})

it('组字中的 Escape/Enter 保留草稿，正常快捷键才重新检查', async () => {
  prime()
  const bodies: unknown[] = []
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/approval-1/plan'
    )
      return request.json().then((body) => {
        bodies.push(body)
        return Response.json(item().plan)
      })
  })
  const { user } = renderApp(<EditPlanRow item={item()} />)
  await user.click(screen.getByRole('button', { name: '改提示词' }))
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词改成' })
  await user.clear(field)
  await user.type(field, '雨后只留一盏灯')
  for (const mode of ['composing', 'legacy', 'end-229'] as const) {
    for (const key of ['Escape', 'Enter']) {
      fireEvent.compositionStart(field, { data: 'zhong' })
      if (mode === 'end-229') fireEvent.compositionEnd(field, { data: '中' })
      fireEvent.keyDown(field, {
        key,
        code: key,
        keyCode: mode === 'end-229' ? 229 : key === 'Enter' ? 13 : 27,
        metaKey: key === 'Enter',
        isComposing: mode === 'composing',
      })
      expect(field.value).toBe('雨后只留一盏灯')
      expect(field).toBe(document.activeElement)
      fireEvent.compositionEnd(field, { data: '中' })
    }
  }
  expect(bodies).toEqual([])
  fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', keyCode: 13, metaKey: true })
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '提示词改成' })).toBeNull())
  expect(bodies).toEqual([{ edits: [{ id: 'n1', params: { prompt: '雨后只留一盏灯' } }] }])
})

it('重新检查失败保留内容，重试等待中重挂载仍锁定批准', async () => {
  prime()
  let requests = 0
  const pending = deferred<Response>()
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/approval-1/plan'
    ) {
      requests++
      return requests === 1
        ? Response.json({ error: 'revise_failed', message: '重新检查失败' }, { status: 503 })
        : pending.promise
    }
  })
  const view = renderApp(<EditPlanRow item={item()} />)
  await view.user.click(screen.getByRole('button', { name: '改提示词' }))
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词改成' })
  await view.user.clear(field)
  await view.user.type(field, '恢复后的新方案文字')
  await view.user.click(screen.getByRole('button', { name: '重新检查' }))
  expect((await screen.findByRole('alert')).textContent).toContain('重新检查失败')
  expect(field.value).toBe('恢复后的新方案文字')
  await view.user.click(screen.getByRole('button', { name: '重新检查' }))
  expect(field.disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '只改文字' }).disabled).toBe(true)
  view.rerender(<></>)
  view.rerender(<EditPlanRow item={item()} />)
  const card = screen.getByRole('group', { name: /^修改方案：/ })
  expect(card.getAttribute('data-revising')).toBe('true')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '只改文字' }).disabled).toBe(true)
  pending.resolve(Response.json(item().plan))
  await waitFor(() => expect(useAgent.getState().pendingActions).toEqual({}))
  expect(screen.queryByRole('textbox', { name: '提示词改成' })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '只改文字' }).disabled).toBe(false)
})

it('重新检查完成后不抢回用户已移开的焦点', async () => {
  prime()
  const pending = deferred<Response>()
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/approval-1/plan'
    )
      return pending.promise
  })
  const { user } = renderApp(
    <>
      <input aria-label="其他输入" />
      <EditPlanRow item={item()} />
    </>,
  )
  await user.click(screen.getByRole('button', { name: '改提示词' }))
  const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词改成' })
  await user.clear(field)
  await user.type(field, '第二次重新检查后的文字')
  fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', keyCode: 13, metaKey: true })
  expect(field.disabled).toBe(true)
  const other = screen.getByRole<HTMLInputElement>('textbox', { name: '其他输入' })
  await user.click(other)
  await user.type(other, '继续写自己的输入')
  act(() => pending.resolve(Response.json(item().plan)))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '提示词改成' })).toBeNull())
  expect(other).toBe(document.activeElement)
  expect(other.value).toBe('继续写自己的输入')
})

it('修改方案确认失败后可重试，等待期间重挂载禁止相反决定', async () => {
  prime()
  const decisions: unknown[] = []
  const pending = deferred<Response>()
  mockFetch((request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/agent/sessions/s1/approvals/approval-1'
    )
      return request.json().then((body) => {
        decisions.push(body)
        return decisions.length === 1
          ? Response.json({ message: '确认暂时失败' }, { status: 503 })
          : pending.promise
      })
  })
  const view = renderApp(<EditPlanRow item={item()} />)
  await view.user.click(screen.getByRole('button', { name: '只改文字' }))
  await waitFor(() => expect(useAgent.getState().error).toBe('确认暂时失败'))
  await view.user.click(screen.getByRole('button', { name: '只改文字' }))
  view.rerender(<></>)
  view.rerender(<EditPlanRow item={item()} />)
  const approve = screen.getByRole<HTMLButtonElement>('button', { name: '只改文字' })
  const reject = screen.getByRole<HTMLButtonElement>('button', { name: '不用了' })
  expect(approve.disabled).toBe(true)
  expect(reject.disabled).toBe(true)
  await view.user.click(reject)
  expect(decisions).toEqual([
    { allow: true, scope: 'text' },
    { allow: true, scope: 'text' },
  ])
  pending.resolve(new Response(null, { status: 204 }))
  await waitFor(() => expect(approve.disabled).toBe(false))
  expect(useAgent.getState().error).toBeNull()
})

it('修改方案定位只使用仍存在的目标，删除后撤下入口，撤销后恢复', async () => {
  prime()
  const doc = openDoc()
  const a = createElement(doc, node({ name: '目标甲' }))
  const b = createElement(doc, node({ name: '目标乙' }))
  doc.flush()
  const flyTo = vi.fn()
  useCanvas.setState({ engine: { doc, flyTo } as unknown as Engine })
  const value = item()
  const target = value.plan.targets[0]!
  value.plan.targets = [
    { ...target, nodeId: a, name: '目标甲' },
    { ...target, nodeId: b, name: '目标乙' },
  ]
  const { user } = renderApp(<EditPlanRow item={value} />)
  act(() => {
    doc.undo.stopCapturing()
    deleteElements(doc, [a])
    doc.flush()
  })
  await user.click(screen.getByRole('button', { name: '在画布上查看' }))
  expect(flyTo).toHaveBeenLastCalledWith([b])
  act(() => {
    doc.undo.stopCapturing()
    deleteElements(doc, [b])
    doc.flush()
  })
  expect(screen.queryByRole('button', { name: '在画布上查看' })).toBeNull()
  act(() => {
    doc.undo.undo()
    doc.flush()
  })
  await user.click(screen.getByRole('button', { name: '在画布上查看' }))
  expect(flyTo).toHaveBeenLastCalledWith([b])
  doc.destroy()
})
