// @vitest-environment happy-dom
import { Engine } from '@plein/canvas-core'
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { JobList } from '@plein/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { useAgent } from '../features/agent/store'
import { useCancelRequests } from '../features/runs/cancelRequests'
import { useGroupRuns } from '../features/runs/groupRuns'
import { Tasks } from '../features/runs/Tasks'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { mockFetch } from '../testing/fetch'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
  within,
} from '../testing/render'
import { FrameBar } from './FrameBar'

resetStoreAfterEach(useGroupRuns)
resetStoreAfterEach(useCancelRequests)
resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useAgent)
const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

it('任务面板与分组工具条共享停止等待，重开仍禁用，失败保留运行且可重试', async () => {
  const doc = openDoc()
  docs.push(doc)
  const frame = createElement(doc, {
    kind: 'frame',
    x: 100,
    y: 100,
    w: 500,
    h: 300,
    name: '待停止分组',
  })
  const host = document.createElement('div')
  const engine = new Engine({ host, doc })
  engine.selection.set([frame])
  useCanvas.setState({ engine, canvasId: 'canvas', tasks: true })
  useGroupRuns.getState().begin(frame)
  useGroupRuns.getState().started(frame, 'group')
  const list: JobList = {
    jobs: [],
    groups: [
      {
        id: 'group',
        status: 'running',
        total: 5,
        frameId: frame,
        scope: 'frame',
        createdAt: Date.now(),
      },
    ],
  }
  let calls = 0
  let release!: (response: Response) => void
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/canvases/canvas/jobs') return Response.json(list)
    if (request.method === 'POST' && path === '/api/runs/groups/group/cancel') {
      calls++
      return calls === 1
        ? new Promise((resolve) => {
            release = resolve
          })
        : new Response(null, { status: 204 })
    }
  })
  const { user } = renderApp(
    <>
      <FrameBar remote />
      <Tasks />
    </>,
  )
  const stop = await screen.findByRole<HTMLButtonElement>('button', { name: '停止整组' })
  act(() => {
    fireEvent.click(stop)
    fireEvent.click(stop)
  })
  await waitFor(() => expect(calls).toBe(1))
  expect(stop.disabled).toBe(true)
  const toolbarStop = screen.getByRole<HTMLButtonElement>('button', { name: '停止运行' })
  expect(toolbarStop.disabled).toBe(true)
  expect(toolbarStop.getAttribute('aria-busy')).toBe('true')
  await user.click(
    within(screen.getByRole('complementary', { name: '任务' })).getByRole('button', {
      name: '关闭',
    }),
  )
  act(() => useCanvas.getState().toggleTasks(true))
  expect(
    (await screen.findByRole<HTMLButtonElement>('button', { name: '停止整组' })).disabled,
  ).toBe(true)
  await act(async () => {
    release(Response.json({ message: '停止失败，请重试' }, { status: 503 }))
  })
  await waitFor(() =>
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '停止整组' }).disabled).toBe(
      false,
    ),
  )
  expect(useCanvas.getState().notice).toBe('停止失败，请重试')
  expect(useGroupRuns.getState().runs[frame]).toBe('group')
  await user.click(screen.getByRole('button', { name: '停止整组' }))
  await waitFor(() => expect(useCancelRequests.getState().pending.size).toBe(0))
  expect(calls).toBe(2)
})
