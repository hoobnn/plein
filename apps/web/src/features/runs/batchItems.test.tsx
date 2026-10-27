// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { BatchItem, JobList } from '@plein/protocol'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { renderApp, screen, waitFor } from '../../testing/render'
import { mockFetch } from '../../testing/fetch'
import { Tasks } from './Tasks'

const canvasId = 'canvas-a'
const groupId = 'group-1'
const frameId = 'frame-1'

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function setup() {
  const doc = openDoc()
  docs.push(doc)
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 400, h: 300, name: '分组' })
  const node = createElement(doc, { kind: 'node', x: 0, y: 0, w: 100, h: 100, name: '镜头甲' })
  const engine = { doc } as unknown as Engine
  useCanvas.setState({ engine, canvasId, tasks: true })
  return { doc, engine, frame, node }
}

const jobs: JobList = {
  jobs: [],
  groups: [
    {
      id: groupId,
      status: 'done',
      total: 1,
      frameId,
      scope: 'frame',
      createdAt: 1,
      summary: { succeeded: 1, cached: 0, failed: 0, canceled: 0, skipped: 0 },
    },
  ],
}

const item = (over: Partial<BatchItem> = {}): BatchItem => ({
  nodeId: 'node-1',
  seq: 0,
  stage: 'run',
  deps: [],
  outcome: 'succeeded',
  updatedAt: 1,
  ...over,
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 渲染任务面板并展开批次记录 */
async function openBatchItems(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: '批次记录' }))
}

describe('批次记录读取与恢复', () => {
  it('首次读取失败时给出可重试入口，重新读取成功后展示记录', async () => {
    setup()
    let fail = true
    mockFetch(async (request) => {
      if (request.url.endsWith(`/api/runs/groups/${groupId}/items`))
        return fail ? json({ error: 'boom', message: '读取批次记录失败' }, 500) : json([item()])
      if (request.url.endsWith(`/api/canvases/${canvasId}/jobs`)) return json(jobs)
      return undefined
    })
    const { user } = renderApp(<Tasks />)
    await openBatchItems(user)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('读取批次记录失败'))
    expect(screen.getByRole('button', { name: '重新读取批次记录' })).toBeTruthy()

    fail = false
    await user.click(screen.getByRole('button', { name: '重新读取批次记录' }))
    await waitFor(() => expect(screen.getByRole('list', { name: '批次记录' })).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('刷新失败时保留上次读到的记录并说明来源，重新读取可恢复', async () => {
    setup()
    let fail = false
    mockFetch(async (request) => {
      if (request.url.endsWith(`/api/runs/groups/${groupId}/items`))
        return fail ? json({ error: 'boom', message: '刷新批次记录失败' }, 500) : json([item()])
      if (request.url.endsWith(`/api/canvases/${canvasId}/jobs`)) return json(jobs)
      return undefined
    })
    const { user } = renderApp(<Tasks />)
    await openBatchItems(user)
    await waitFor(() => expect(screen.getByRole('list', { name: '批次记录' })).toBeTruthy())

    fail = true
    await user.click(screen.getByRole('button', { name: '刷新批次记录' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('刷新批次记录失败'))
    // 旧数据仍在，并说明仍为上次读到的内容
    expect(screen.getByRole('list', { name: '批次记录' })).toBeTruthy()
    expect(screen.getByText('以下仍为上次读取的批次记录。')).toBeTruthy()

    fail = false
    await user.click(screen.getByRole('button', { name: '重新读取批次记录' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('读取进行中收起重开共享同一次请求，不重复拉取', async () => {
    setup()
    let requests = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mockFetch(async (request) => {
      if (request.url.endsWith(`/api/runs/groups/${groupId}/items`)) {
        requests++
        await gate
        return json([item()])
      }
      if (request.url.endsWith(`/api/canvases/${canvasId}/jobs`)) return json(jobs)
      return undefined
    })
    const { user } = renderApp(<Tasks />)
    await openBatchItems(user)
    await waitFor(() => expect(requests).toBe(1))

    // 读取还在进行中：收起再展开复用同一次请求
    await user.click(screen.getByRole('button', { name: '收起批次记录' }))
    await user.click(screen.getByRole('button', { name: '批次记录' }))
    expect(requests).toBe(1)
    const refresh = screen.getByRole('button', { name: '刷新批次记录' })
    expect(refresh.getAttribute('aria-busy')).toBe('true')
    expect(refresh.hasAttribute('disabled')).toBe(true)

    release()
    await waitFor(() => expect(screen.getByRole('list', { name: '批次记录' })).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '刷新批次记录' }).hasAttribute('disabled')).toBe(
      false,
    )
  })
})
