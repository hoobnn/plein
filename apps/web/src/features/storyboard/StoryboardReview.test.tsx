// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { afterEach, expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor, within } from '../../testing/render'
import { StoryboardReview } from './StoryboardReview'
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
it('逐镜审核恢复仅获取当前任务，不新提交或运行其他镜头', async () => {
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
  const f = renderApp(
    <StoryboardReview
      engine={engine}
      boardId={board}
      shots={shots}
      picked={new Set()}
      onPick={() => {}}
    />,
  )
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
