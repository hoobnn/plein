// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement } from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { JobInfo } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { queryKeys } from '../../api/query'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { useRecoveryRequests } from '../runs/recoveryRequests'
import { StoryboardReview } from './StoryboardReview'

resetStoreAfterEach(useCatalog)
resetStoreAfterEach(useRecoveryRequests)
const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
async function setup() {
  const doc = createDoc(undefined, { schedule: () => {} })
  docs.push(doc)
  const shot = Shot.parse({ id: 'shot', no: 1, description: '保持镜头' })
  const board = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: { shots: [shot] },
  })
  const image = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: { source: { storyboard: board, shot: shot.id, role: 'image' } },
  })
  const engine = { doc, selection: { set: vi.fn() }, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas' })
  let job: JobInfo = {
    id: 'old',
    nodeId: image,
    nodeType: 'plein/image',
    status: 'failed',
    attempts: 1,
    createdAt: 1,
    recovery: { state: 'submit_unknown', provider: '旧平台', attachable: true },
  }
  const calls: Array<{ id: string; body: unknown }> = []
  let fail = false,
    held = false
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/jobs/latest'))
      return Response.json({ jobs: [job] })
    if (request.method === 'POST' && path.endsWith('/recover')) {
      calls.push({ id: path.split('/').at(-2)!, body: await request.json() })
      if (held) await pending
      if (fail) {
        fail = false
        return Response.json({ message: '恢复暂时失败' }, { status: 503 })
      }
      return Response.json(job)
    }
  })
  const view = renderApp(
    <StoryboardReview
      engine={engine}
      boardId={board}
      shots={[shot]}
      picked={new Set()}
      onPick={() => {}}
    />,
  )
  await screen.findByTestId('job-recovery')
  const next = async () => {
    act(() => {
      job = { ...job, id: 'new', createdAt: 2, recovery: { ...job.recovery!, provider: '新平台' } }
      view.queryClient.setQueriesData({ queryKey: queryKeys.canvasJobs('canvas') }, { jobs: [job] })
    })
    await waitFor(() => expect(screen.getByTestId('job-recovery').textContent).toContain('新平台'))
  }
  return {
    ...view,
    calls,
    next,
    release,
    fail: () => {
      fail = true
    },
    hold: () => {
      held = true
    },
  }
}

it.each(['attach', 'confirm', 'error'] as const)(
  '最新原任务变化清除旧 %s 草稿，只向新任务恢复',
  async (draft) => {
    const f = await setup()
    if (draft === 'confirm')
      await f.user.click(screen.getByRole('button', { name: '确认未受理，重新提交' }))
    else {
      await f.user.click(screen.getByRole('button', { name: '填写平台任务 ID' }))
      await f.user.type(screen.getByRole('textbox', { name: '平台任务 ID' }), 'old-id')
      if (draft === 'error') {
        f.fail()
        await f.user.click(screen.getByRole('button', { name: '接着取结果' }))
        await screen.findByRole('alert')
      }
    }
    await f.next()
    expect(screen.queryByRole('textbox', { name: '平台任务 ID' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新提交' })).toBeNull()
    await f.user.click(screen.getByRole('button', { name: '填写平台任务 ID' }))
    await f.user.type(screen.getByRole('textbox', { name: '平台任务 ID' }), 'new-id')
    await f.user.click(screen.getByRole('button', { name: '接着取结果' }))
    await waitFor(() =>
      expect(f.calls.at(-1)).toEqual({ id: 'new', body: { action: 'attach', remoteId: 'new-id' } }),
    )
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '平台任务 ID' })).toBeNull())
  },
)

it('旧恢复应答迟到不清空新任务未提交的 ID', async () => {
  const f = await setup()
  f.hold()
  await f.user.click(screen.getByRole('button', { name: '填写平台任务 ID' }))
  await f.user.type(screen.getByRole('textbox', { name: '平台任务 ID' }), 'old-id')
  await f.user.click(screen.getByRole('button', { name: '接着取结果' }))
  await waitFor(() => expect(f.calls).toHaveLength(1))
  await f.next()
  await f.user.click(screen.getByRole('button', { name: '填写平台任务 ID' }))
  await f.user.type(screen.getByRole('textbox', { name: '平台任务 ID' }), 'new-unsent')
  await act(async () => {
    f.release()
  })
  await waitFor(() => expect(useRecoveryRequests.getState().pending.size).toBe(0))
  expect((screen.getByRole('textbox', { name: '平台任务 ID' }) as HTMLInputElement).value).toBe(
    'new-unsent',
  )
  expect(f.calls).toEqual([{ id: 'old', body: { action: 'attach', remoteId: 'old-id' } }])
})
