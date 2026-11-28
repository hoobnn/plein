// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, type PleinDoc, writeRun } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { afterEach, expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor, within } from '../../testing/render'
import { StoryboardReview } from './StoryboardReview'
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setupBoard() {
  const doc = openDoc()
  docs.push(doc)
  const shots = [1, 2].map((no) => Shot.parse({ id: `s${no}`, no, description: `画面${no}` }))
  const board = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    params: { shots },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const images = shots.map((shot) =>
    createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      name: `图${shot.no}`,
      params: { source: { storyboard: board, shot: shot.id, role: 'image' } },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    }),
  )
  const engine = { doc } as Engine
  useCanvas.setState({ engine, canvasId: 'c', sync: 'connected' })
  const render = () =>
    renderApp(
      <StoryboardReview
        engine={engine}
        boardId={board}
        shots={shots}
        picked={new Set()}
        onPick={() => {}}
      />,
    )
  return { doc, images, render }
}

it('逐镜审核恢复仅获取当前任务，不新提交或运行其他镜头', async () => {
  const { doc, images, render } = setupBoard()
  const writes: unknown[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/canvases/c/jobs/latest')
      return Response.json({
        jobs: [
          {
            id: 'existing-job',
            nodeId: images[0],
            nodeType: 'plein/image',
            status: 'failed',
            attempts: 1,
            error: '保存中断',
            createdAt: 1,
            recovery: { state: 'fetch_failed', refetchable: true, remoteId: 'remote-kept' },
          },
        ],
        groups: [],
      })
    if (path === '/api/canvases/c/jobs/existing-job/recover') {
      writes.push(await request.json())
      return Response.json({ ok: true })
    }
  })
  const f = render()
  const row = document.querySelector<HTMLElement>('[data-shot-id="s1"]')!
  const button = await within(row).findByRole('button', { name: '重新获取' })
  expect(within(row).getByTestId('job-recovery').textContent).toContain(
    '平台已生成，结果没存到本地',
  )
  expect(
    within(document.querySelector<HTMLElement>('[data-shot-id="s2"]')!).queryByTestId(
      'job-recovery',
    ),
  ).toBeNull()
  const before = [...doc.elements()]
  await f.user.click(button)
  await waitFor(() => expect(writes).toEqual([{ action: 'refetch' }]))
  expect([...doc.elements()]).toEqual(before)
  expect(screen.getByRole('table', { name: '逐镜审核' })).toBeTruthy()
})

it('读取全表任务只显示一次反馈，生成和取消均绑定当前镜头', async () => {
  const { doc, images, render } = setupBoard()
  let releaseJobs!: () => void, releaseRun!: () => void, releaseCancel!: () => void
  const jobs = new Promise<void>((resolve) => {
    releaseJobs = resolve
  })
  const run = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  const cancel = new Promise<void>((resolve) => {
    releaseCancel = resolve
  })
  const canceled: unknown[] = []
  let runCalls = 0
  const node = images[0]!
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/jobs/latest')) {
      await jobs
      return Response.json({ jobs: [] })
    }
    if (path === `/api/canvases/c/nodes/${node}/run`) {
      runCalls++
      await run
      return Response.json({ runId: 'my-run' })
    }
    if (path === `/api/canvases/c/nodes/${node}/cancel`) {
      canceled.push(await request.json())
      await cancel
      return new Response(null, { status: 204 })
    }
  })
  const { user } = render()
  expect(screen.getAllByText('正在读取镜头任务…')).toHaveLength(1)
  releaseJobs()
  const row = within(document.querySelector<HTMLElement>('[data-shot-id="s1"]')!)
  const start = row.getByRole('button', { name: '生成此项' })
  await waitFor(() => expect(start.hasAttribute('disabled')).toBe(false))
  await user.click(start)
  expect(row.getByRole('button', { name: '正在提交…' }).hasAttribute('disabled')).toBe(true)
  await act(async () => releaseRun())
  // HTTP 已受理，协作文档尚未同步，此时不会再次提交同一个任务。
  expect(row.queryByRole('button', { name: '生成此项' })).toBeNull()
  expect(row.getByRole('button', { name: '取消生成' })).toBeTruthy()
  await act(async () => {
    writeRun(doc, node, { id: 'my-run', status: 'running', at: 1 })
    doc.flush()
  })
  await user.click(row.getByRole('button', { name: '取消生成' }))
  expect(row.getByRole('button', { name: '正在取消…' }).hasAttribute('disabled')).toBe(true)
  expect(canceled).toEqual([{ runId: 'my-run' }])
  await act(async () => {
    writeRun(doc, node, { id: 'my-run', status: 'canceled', at: 2 })
    doc.flush()
    releaseCancel()
  })
  expect(await row.findByText(/已取消/)).toBeTruthy()
  act(() => {
    writeRun(doc, node, { id: 'peer-run', status: 'running', at: 3 })
    doc.flush()
  })
  const stop = row.getByRole('button', { name: '取消生成' })
  await user.pointer({ keys: '[MouseLeft>]', target: stop })
  act(() => {
    writeRun(doc, node, { id: 'peer-run', status: 'succeeded', at: 4 })
    doc.flush()
  })
  const next = row.getByRole('button', { name: '生成此项' })
  expect(stop.isConnected).toBe(false)
  await user.pointer({ keys: '[/MouseLeft]', target: next })
  expect(runCalls).toBe(1)
  expect(canceled).toHaveLength(1)
})
