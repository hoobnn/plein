// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  connect,
  createElement,
  creativeReviewTarget,
  recordCreativeReview,
  updateElement,
  writeRun,
  type DeliveryRecord,
  type PleinDoc,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import type { JobInfo } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, within } from '../../testing/render'
import { useStale } from '../runs/stale'
import { creationGuideFacts } from './facts'
import { ProductionOverview } from './ProductionOverview'

resetStoreAfterEach(useStale)
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const boardId = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    name: '当前分镜',
    params: {
      shots: [1, 2].map((no) =>
        Shot.parse({ id: `shot-${no}`, no, description: `镜头${no}`, duration: 4 }),
      ),
    },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const engine = { doc, selection: { set: vi.fn() }, zoomToFit: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'c' })
  const readCurrent = () => creationGuideFacts(doc, { boardId, canvasId: 'c' })
  const onError = vi.fn()
  function Harness() {
    useDocVersion(doc)
    return (
      <ProductionOverview
        engine={engine}
        canvasId="c"
        facts={readCurrent()}
        writable
        readCurrent={readCurrent}
        onError={onError}
      />
    )
  }
  const node = (role: 'image' | 'video', shot: number, name: string) =>
    createElement(doc, {
      kind: 'node',
      nodeType: `plein/${role}`,
      name,
      params: { source: { storyboard: boardId, shot: `shot-${shot}`, role } },
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
  const result = (id: string, type: 'image' | 'video', adopt: boolean) =>
    addResults(
      doc,
      id,
      [{ id: `result-${id}`, runId: `run-${id}`, at: 1, port: type, value: { type, assetId: id } }],
      { adopt },
    )
  return { doc, boardId, engine, onError, node, result, render: () => renderApp(<Harness />) }
}

it('未展开节点明确显示未完成，当前项目索引只在展开后读取', async () => {
  const f = fixture()
  const paths: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    paths.push(path)
    if (path === '/api/canvases/c') return Response.json({ id: 'c', projectId: 'project' })
    if (path === '/api/projects/project/canvases')
      return Response.json([
        { id: 'c', title: '当前画布' },
        { id: 'other', title: '第二集' },
      ])
  })
  const view = f.render()
  const stats = within(screen.getByLabelText('制作事实统计'))
  for (const label of ['已有产物 0/0 节点', '已采用 0/0 节点', '人工可用 0/0 节点'])
    expect(stats.getByText(label)).toBeTruthy()
  expect(stats.getByText('已交付 未确认当前成片')).toBeTruthy()
  expect(screen.getByText('尚未展开当前分镜的生成节点。')).toBeTruthy()
  expect(paths).toEqual([])
  await view.user.click(screen.getByText('当前项目的画布'))
  expect((await screen.findByRole('link', { name: '第二集' })).getAttribute('href')).toBe(
    '#/c/other',
  )
  expect(screen.getByRole('link', { name: '当前画布（当前）' }).getAttribute('aria-current')).toBe(
    'page',
  )
  expect(paths).toEqual(['/api/canvases/c', '/api/projects/project/canvases'])
})

it('产物、采用、人工可用与进行中分列，失败任务重试后定位真实节点', async () => {
  const f = fixture()
  const usable = f.node('image', 1, '已核对画面')
  const candidate = f.node('video', 1, '待采用视频')
  const running = f.node('image', 2, '生成中画面')
  const failed = f.node('video', 2, '失败视频')
  f.result(usable, 'image', true)
  f.result(candidate, 'video', false)
  recordCreativeReview(f.doc, usable, {
    target: creativeReviewTarget(f.doc.get(usable))!,
    status: 'usable',
  })
  writeRun(f.doc, running, { id: 'running', status: 'running', at: 1 })
  useStale.getState().set({ stale: [], upstream: [], kept: [usable] })
  const requests: string[][] = []
  let fail = true
  const job: JobInfo = {
    id: 'failed-job',
    nodeId: failed,
    nodeType: 'plein/video',
    status: 'failed',
    attempts: 1,
    createdAt: 1,
    recovery: { state: 'remote_failed' },
  }
  mockFetch(async (request) => {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === '/api/canvases/c/jobs/latest'
    ) {
      requests.push((await request.json()).nodes)
      return fail
        ? Response.json({ error: 'unavailable', message: '任务读取暂时中断' }, { status: 503 })
        : Response.json({ jobs: [job] })
    }
  })
  const view = f.render()
  const stats = within(screen.getByLabelText('制作事实统计'))
  for (const label of [
    '已有产物 2/4 节点',
    '已采用 1/4 节点',
    '人工可用 1/4 节点',
    '进行中 1 节点',
    '旧输入／已保留 1 节点',
  ])
    expect(stats.getByText(label)).toBeTruthy()
  expect(requests).toEqual([])
  await view.user.click(screen.getByRole('button', { name: '检查任务' }))
  expect(await screen.findByText(/任务读取失败（重试）：任务读取暂时中断/)).toBeTruthy()
  fail = false
  await view.user.click(screen.getByRole('button', { name: '重试' }))
  const issues = within(screen.getByRole('list', { name: '制作待处理事项' }))
  const failure = await issues.findByRole('button', { name: /失败视频：.*失败.*定位/ })
  expect(issues.getByRole('button', { name: /待采用视频：已有产物，等待选择采用/ })).toBeTruthy()
  expect(requests).toEqual([1, 2].map(() => [usable, candidate, running, failed].sort()))
  await view.user.click(failure)
  expect(f.engine.selection.set).toHaveBeenLastCalledWith([failed])
  expect(f.engine.zoomToFit).toHaveBeenLastCalledWith([failed])
  expect(useCanvas.getState().tasks).toBe(true)
  expect(screen.queryByText(/任务读取失败/)).toBeNull()
})

it('任务未检查、读取中或失败时不断言无待处理事项', async () => {
  const f = fixture()
  f.node('image', 1, '画面')
  let mode: 'pending' | 'success' | 'fail' = 'pending'
  let release: ((response: Response) => void) | undefined
  mockFetch(() => {
    if (mode === 'pending')
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    return mode === 'fail'
      ? Response.json({ error: 'unavailable', message: '任务读取暂时中断' }, { status: 503 })
      : Response.json({ jobs: [] })
  })
  const view = f.render()
  expect(screen.getByText('任务尚未检查')).toBeTruthy()
  expect(screen.getByText('阻塞、待审与任务（本地 0）')).toBeTruthy()
  expect(screen.queryByText('当前未发现待处理事项。')).toBeNull()
  await view.user.click(screen.getByRole('button', { name: '检查任务' }))
  expect(await screen.findByText('正在读取任务')).toBeTruthy()
  expect(screen.queryByText('当前未发现待处理事项。')).toBeNull()
  mode = 'success'
  release!(Response.json({ jobs: [] }))
  expect(await screen.findByText('当前未发现待处理事项。')).toBeTruthy()
  expect(screen.getByText('阻塞、待审与任务（0）')).toBeTruthy()
  mode = 'fail'
  await view.user.click(screen.getByRole('button', { name: '刷新任务' }))
  expect(await screen.findByText(/任务读取失败（重试）/)).toBeTruthy()
  expect(screen.queryByText('当前未发现待处理事项。')).toBeNull()
  expect(screen.getByText('阻塞、待审与任务（本地 0）')).toBeTruthy()
})

it('交付序列未明确时说明范围而不误报未保存目标', () => {
  const f = fixture()
  const video = f.node('video', 1, '视频')
  f.result(video, 'video', true)
  updateElement(f.doc, video, {
    ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
  })
  const film = (name: string) => {
    const id = createElement(f.doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      name,
      params: {},
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    updateElement(f.doc, id, {
      ports: {
        inputs: [{ id: 'clips', label: '镜头', type: 'video', multiple: true }],
        outputs: [],
      },
    })
    expect(connect(f.doc, [video, 'video'], [id, 'clips'])).toBeTruthy()
    return id
  }
  film('第一版')
  film('第二版')
  f.render()
  expect(screen.getByText(/计划 8.0 秒 \/ 交付序列未明确/)).toBeTruthy()
  expect(screen.queryByText(/未保存目标/)).toBeNull()
})

it('尚未确认的成片仍显示实际时长与分辨率', () => {
  const f = fixture()
  const video = f.node('video', 1, '视频')
  f.result(video, 'video', true)
  updateElement(f.doc, video, {
    ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
  })
  const film = createElement(f.doc, {
    kind: 'node',
    nodeType: 'plein/sequence',
    name: '成片',
    params: {},
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  updateElement(f.doc, film, {
    ports: {
      inputs: [{ id: 'clips', label: '镜头', type: 'video', multiple: true }],
      outputs: [{ id: 'video', label: '视频', type: 'video' }],
    },
  })
  expect(connect(f.doc, [video, 'video'], [film, 'clips'])).toBeTruthy()
  const output = {
    id: 'film-result',
    runId: 'film-run',
    at: 1,
    port: 'video',
    value: { type: 'video' as const, assetId: 'b'.repeat(64) },
  }
  addResults(f.doc, film, [output], { adopt: true })
  const record: DeliveryRecord = {
    id: 'delivery',
    resultId: output.id,
    runId: output.runId,
    assetId: 'b'.repeat(64),
    kind: 'film',
    version: 'v1',
    createdAt: 1,
    width: 720,
    height: 1280,
    duration: 5,
    sources: [],
    notes: [{ id: 'note', time: 2, text: '声音太小', resolved: false }],
    confirmedAt: 2,
  }
  updateElement(f.doc, film, { deliveries: [record] })
  f.render()
  expect(screen.getByText('交付：当前成片未确认 · 实际 5.0 秒 · 720×1280')).toBeTruthy()
})
