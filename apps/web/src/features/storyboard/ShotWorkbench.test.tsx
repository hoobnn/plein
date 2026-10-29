// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  connect,
  createDoc,
  createElement,
  recordContinuityObservation,
  recordCreativeReview,
  registerContinuitySubject,
  setParam,
  type PleinDoc,
} from '@plein/doc'
import { Shot } from '@plein/nodes'
import type { PreparedInput } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { resetStoreAfterEach } from '../../testing/render'
import { ShotWorkbench } from './ShotWorkbench'

resetStoreAfterEach(useCatalog)

const textValue = (element: HTMLElement) => (element as HTMLTextAreaElement).value
const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

const rows = () =>
  ['one', 'two'].map((id, index) =>
    Shot.parse({
      id,
      no: index + 1,
      duration: 3,
      description: `镜头 ${index + 1} 原始描述`,
      imagePrompt: '原始首帧',
      motionPrompt: `镜头 ${index + 1} 原始运动`,
      lighting: '原始光影',
    }),
  )

function fixture(expanded = false) {
  const doc = createDoc()
  docs.push(doc)
  const shots = rows()
  const board = createElement(doc, {
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    id: 'board',
    kind: 'node',
    nodeType: 'plein/storyboard',
    params: { shots },
  })
  const videos: string[] = []
  if (expanded)
    for (const [index, shot] of shots.entries()) {
      const node = createElement(doc, {
        x: 0,
        y: 0,
        w: 100,
        h: 80,
        id: `video-${shot.id}`,
        kind: 'node',
        nodeType: 'plein/video',
        ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
        params: {
          prompt: shot.motionPrompt,
          model: 'mock:video',
          source: { storyboard: board, shot: shot.id, role: 'video' },
        },
      })
      videos.push(node)
      if (index === 0)
        addResults(doc, node, [
          {
            id: `candidate-${shot.id}`,
            runId: 'run-one',
            port: 'video',
            at: 1,
            value: { type: 'video', assetId: 'a'.repeat(64) },
          },
        ])
      else {
        const legacy = {
          id: `candidate-${shot.id}`,
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: 'a'.repeat(64) },
        }
        doc.mutable(node)!.set('results', [legacy])
        doc.mutable(node)!.set('adopted', legacy.id)
      }
    }
  const engine = {
    doc,
    selection: { set: vi.fn(), values: vi.fn(() => []) },
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({
    engine,
    canvasId: 'canvas',
    shotWorkbench: { boardId: board, shotId: 'one' },
  })
  useSession.setState({ info: { principal: { id: 'local', role: 'owner' } } as never })
  useCatalog.setState({ catalog: null })
  return { doc, engine, board, shots, videos }
}

function prepared(nodeId: string, prompt: string): PreparedInput {
  return {
    v: 1,
    nodeId,
    nodeType: 'plein/video',
    preparedAt: 1,
    status: 'ready',
    inputHash: `hash-${nodeId}`,
    params: { prompt },
    model: { ref: 'mock:video', provider: 'mock', title: 'Mock video' },
    prompt,
    inputs: {},
    refs: [],
    blocked: [],
    notices: [],
  }
}

it('切镜保留未保存草稿，远端冲突禁止覆盖且只读不写', async () => {
  const { doc, board, shots } = fixture()
  const fetch = mockFetch()
  const { user } = renderApp(<ShotWorkbench />)
  let field = screen.getByRole('textbox', { name: '工作台画面描述' })
  await user.clear(field)
  await user.type(field, '第一镜未保存草稿')
  await user.click(screen.getByRole('button', { name: '下一镜' }))
  field = screen.getByRole('textbox', { name: '工作台画面描述' })
  await waitFor(() => expect(textValue(field)).toBe('镜头 2 原始描述'))
  expect((screen.getByRole('button', { name: '下一镜' }) as HTMLButtonElement).disabled).toBe(true)
  await user.clear(field)
  await user.type(field, '第二镜未保存草稿')
  await user.click(screen.getByRole('button', { name: '上一镜' }))
  field = screen.getByRole('textbox', { name: '工作台画面描述' })
  await waitFor(() => expect(textValue(field)).toBe('第一镜未保存草稿'))
  expect(doc.get(board)?.params?.shots).toEqual(shots)
  act(() => {
    setParam(
      doc,
      board,
      'shots',
      shots.map((shot, index) => (index ? shot : { ...shot, description: '远端新版本' })),
    )
    doc.flush()
  })
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: '保存本镜字段' }) as HTMLButtonElement).disabled,
    ).toBe(true),
  )
  expect(textValue(field)).toBe('第一镜未保存草稿')
  await user.click(screen.getByRole('button', { name: '重新载入本镜' }))
  await waitFor(() => expect(textValue(field)).toBe('远端新版本'))
  act(() => {
    doc.meta.set('schemaVersion', doc.schemaVersion + 1)
    doc.flush()
  })
  await waitFor(() =>
    expect(screen.getByTestId('shot-workbench').textContent).toContain('当前只读'),
  )
  expect((screen.getByRole('button', { name: '保存本镜字段' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  expect(doc.get(board)?.params?.shots).toEqual(
    shots.map((shot, index) => (index ? shot : { ...shot, description: '远端新版本' })),
  )
  expect(fetch).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '返回分镜表' }))
  expect(useCanvas.getState().storyboard).toBe(board)
  expect(useCanvas.getState().shotWorkbench).toBeNull()
})

it('旧 JobInfo 与 nodeInput 晚回不串入已切换镜头', async () => {
  const { doc } = fixture(true)
  let releaseInput!: () => void
  let releaseJob!: () => void
  let inputEntered!: () => void
  let jobEntered!: () => void
  const inputAccepted = new Promise<void>((resolve) => (inputEntered = resolve))
  const jobAccepted = new Promise<void>((resolve) => (jobEntered = resolve))
  const inputGate = new Promise<void>((resolve) => (releaseInput = resolve))
  const jobGate = new Promise<void>((resolve) => (releaseJob = resolve))
  const executions: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/canvases/canvas/nodes/video-one/input') {
      inputEntered()
      return inputGate.then(() => Response.json(prepared('video-one', '第一镜迟到的当前输入')))
    }
    if (request.method === 'GET' && path === '/api/canvases/canvas/jobs/run-one') {
      jobEntered()
      return jobGate.then(() =>
        Response.json({
          id: 'run-one',
          nodeId: 'video-one',
          nodeType: 'plein/video',
          status: 'succeeded',
          attempts: 1,
          createdAt: 1,
          input: prepared('video-one', '第一镜迟到的历史输入'),
        }),
      )
    }
    if (request.method === 'GET' && path === '/api/canvases/canvas/nodes/video-two/input')
      return Response.json(prepared('video-two', '第二镜当前输入'))
    if (request.method === 'POST' && path === '/api/canvases/canvas/jobs/latest')
      return Response.json({ jobs: [] })
    if (
      request.method === 'POST' &&
      /\/(?:run|run-flow|run-batch|storyboard-batch\/commit)$/.test(path)
    )
      executions.push(path)
    return undefined
  })
  const { user } = renderApp(<ShotWorkbench />)
  await Promise.all([inputAccepted, jobAccepted])
  await user.selectOptions(screen.getByLabelText('工作台镜头'), 'two')
  const current = await screen.findByRole('heading', { name: '当前节点实际输入' })
  await waitFor(() => expect(current.parentElement?.textContent).toContain('第二镜当前输入'))
  const historical = screen.getByRole('heading', { name: '此候选生成时实际输入' })
  expect(historical.parentElement?.textContent).toContain('未记录生成任务')
  releaseInput()
  releaseJob()
  await waitFor(() => expect(current.parentElement?.textContent).not.toContain('第一镜迟到'))
  expect(current.parentElement?.textContent).toContain('第二镜当前输入')
  expect(historical.parentElement?.textContent).not.toContain('第一镜迟到的历史输入')
  expect(executions).toEqual([])
  expect(doc.get('board')?.params?.shots).toEqual(rows())
})

function workbenchReads(doc: PleinDoc, reads: string[]) {
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    const input = path.match(/^\/api\/canvases\/canvas\/nodes\/([^/]+)\/input$/)
    if (request.method === 'GET' && input) {
      reads.push(input[1]!)
      return Response.json(prepared(input[1]!, String(doc.get(input[1]!)?.params?.prompt)))
    }
    if (request.method === 'GET' && path === '/api/canvases/canvas/jobs/run-one')
      return Response.json({
        id: 'run-one',
        nodeId: 'video-one',
        nodeType: 'plein/video',
        status: 'succeeded',
        attempts: 1,
        createdAt: 1,
        input: prepared('video-one', '生成时冻结输入'),
      })
    if (request.method === 'POST' && path === '/api/canvases/canvas/jobs/latest')
      return Response.json({ jobs: [] })
  })
}

it('保存为可用记录当前候选，本镜下游影响定位真实序列并关闭工作台', async () => {
  const { doc, engine, videos } = fixture(true)
  const sequence = createElement(doc, {
    id: 'delivery-sequence',
    kind: 'node',
    nodeType: 'plein/sequence',
    nodeVersion: 2,
    ports: { inputs: [{ id: 'clips', label: '镜头', type: 'video', multiple: true }], outputs: [] },
    name: '两镜成片',
    x: 500,
    y: 0,
    w: 200,
    h: 100,
  })
  expect(connect(doc, [videos[0]!, 'video'], [sequence, 'clips'])).not.toBeNull()
  const original = doc.get(videos[0]!)!
  workbenchReads(doc, [])
  const { user } = renderApp(<ShotWorkbench />)
  const note = await screen.findByRole('textbox', { name: '创作验收备注 · video-one' })
  await user.type(note, '动作和构图可用')
  await user.click(screen.getByRole('checkbox', { name: '构图' }))
  await user.click(screen.getByRole('button', { name: '保存为可用' }))
  await waitFor(() =>
    expect(doc.get(videos[0]!)?.reviews).toEqual([
      expect.objectContaining({
        status: 'usable',
        note: '动作和构图可用',
        tags: ['composition'],
        target: { resultId: 'candidate-one', assetId: 'a'.repeat(64), kind: 'video' },
      }),
    ]),
  )
  expect(doc.get(videos[0]!)?.adopted).toBe(original.adopted)
  expect(doc.get(videos[1]!)?.reviews ?? []).toEqual([])
  const impact = screen.getByLabelText('本镜下游影响')
  await user.click(within(impact).getByText(/下游影响 · 1 个节点/))
  expect(impact.textContent).toContain('两镜成片')
  await user.click(within(impact).getByRole('button', { name: '两镜成片' }))
  expect(engine.selection.set).toHaveBeenCalledWith([sequence])
  expect(engine.zoomToFit).toHaveBeenCalledWith([sequence])
  expect(useCanvas.getState().sequence).toBe(sequence)
  expect(useCanvas.getState().shotWorkbench).toBeNull()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '镜头工作台' })).toBeNull())
})

it('历史预览不自动采用，切候选和关闭回收媒体，重开立即读取新输入', async () => {
  const { doc } = fixture(true)
  const old = doc.get('video-one')!.results![0]!
  doc.mutable('video-one')!.set('results', [old, { ...old, id: 'history' }])
  const reads: string[] = []
  workbenchReads(doc, reads)
  const { user } = renderApp(<ShotWorkbench />)
  const current = () => screen.getByRole('heading', { name: '当前节点实际输入' }).parentElement!
  await waitFor(() => expect(current().textContent).toContain('镜头 1 原始运动'))
  const first = screen.getByLabelText('工作台候选视频') as HTMLVideoElement
  const pause = vi.spyOn(first, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(first, 'load').mockImplementation(() => {})
  await user.selectOptions(screen.getByLabelText('工作台候选'), 'history')
  expect(doc.get('video-one')?.adopted).toBe(old.id)
  expect(screen.getByText(/历史预览，当前采用项保持不变/)).not.toBeNull()
  expect(pause).toHaveBeenCalledOnce()
  expect(load).toHaveBeenCalledOnce()
  expect(first.hasAttribute('src')).toBe(false)
  expect(screen.getByTestId('shot-workbench').querySelectorAll('video')).toHaveLength(1)
  const historical = screen.getByLabelText('工作台候选视频') as HTMLVideoElement
  const cleanup = vi.spyOn(historical, 'pause').mockImplementation(() => {})
  await user.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '镜头工作台' })).toBeNull())
  expect(cleanup).toHaveBeenCalledOnce()
  expect(historical.hasAttribute('src')).toBe(false)
  const before = reads.length
  act(() => {
    setParam(doc, 'video-one', 'prompt', '关闭期间手改的新参数')
    doc.flush()
    useCanvas.setState({ shotWorkbench: { boardId: 'board', shotId: 'one' } })
  })
  await waitFor(() => expect(current().textContent).toContain('关闭期间手改的新参数'))
  expect(reads.length).toBeGreaterThan(before)
  const frozen = screen.getByRole('heading', { name: '此候选生成时实际输入' }).parentElement!
  await waitFor(() => expect(frozen.textContent).toContain('生成时冻结输入'))
  expect(frozen.textContent).not.toContain('关闭期间手改的新参数')
})

it('同帧阶段改绑拒绝采用与审片，只读转换拒绝保存草稿', async () => {
  const { doc, board } = fixture(true)
  const old = doc.get('video-one')!.results![0]!
  doc.mutable('video-one')!.set('results', [old, { ...old, id: 'history' }])
  workbenchReads(doc, [])
  const { user } = renderApp(<ShotWorkbench />)
  await screen.findByRole('button', { name: '保存为可用' })
  await user.selectOptions(screen.getByLabelText('工作台候选'), 'history')
  const source = doc.get('video-one')!.params!.source
  act(() => {
    setParam(doc, 'video-one', 'source', { storyboard: board, shot: 'two', role: 'video' })
    fireEvent.click(screen.getByRole('button', { name: '采用候选' }))
    doc.flush()
  })
  expect(doc.get('video-one')?.adopted).toBe(old.id)
  act(() => {
    setParam(doc, 'video-one', 'source', source)
    doc.flush()
  })
  await user.selectOptions(screen.getByLabelText('工作台阶段节点'), 'video-one')
  await user.selectOptions(screen.getByLabelText('工作台候选'), old.id)
  act(() => {
    setParam(doc, 'video-one', 'source', { storyboard: board, shot: 'two', role: 'video' })
    fireEvent.click(screen.getByRole('button', { name: '保存为可用' }))
    doc.flush()
  })
  expect(doc.get('video-one')?.reviews ?? []).toEqual([])
  const before = doc.get(board)?.params?.shots
  const input = screen.getByRole('textbox', { name: '工作台画面描述' })
  await user.type(input, '不得保存')
  act(() => {
    doc.meta.set('schemaVersion', doc.schemaVersion + 1)
    fireEvent.click(screen.getByRole('button', { name: '保存本镜字段' }))
    doc.flush()
  })
  expect(doc.get(board)?.params?.shots).toEqual(before)
})

it('Alt 方向键切镜，但不打断文本编辑', async () => {
  const { engine } = fixture()
  renderApp(<ShotWorkbench />)
  fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true })
  expect(useCanvas.getState().shotWorkbench?.shotId).toBe('two')
  const input = screen.getByLabelText('工作台画面描述')
  fireEvent.keyDown(input, { key: 'ArrowLeft', altKey: true })
  expect(useCanvas.getState().shotWorkbench?.shotId).toBe('two')
  expect(engine.doc.get('board')).toBeDefined()
})

it('摘要只按实际送入的参考图标记，且不把丢弃的图说成已送入', async () => {
  const { doc, board, shots } = fixture(true)
  createElement(doc, {
    id: 'actor',
    kind: 'node',
    nodeType: 'plein/character',
    name: '角色',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: {},
  })
  setParam(doc, board, 'shots', [
    { ...shots[0]!, characters: ['角色'], assetBindings: { 角色: { elementId: 'actor' } } },
    shots[1]!,
  ])
  setParam(doc, 'video-one', 'prompt', '@角色')
  const input = prepared('video-one', '@角色')
  input.refs = [
    {
      elementId: 'actor',
      name: '角色',
      kind: 'character',
      required: false,
      available: ['ref'],
      sent: ['ref'],
    },
  ]
  input.inputs = { images: [{ type: 'image', assetId: 'ref', source: 'actor' }] }
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/input')) return Response.json(input)
    if (path.endsWith('/jobs/latest')) return Response.json({ jobs: [] })
    if (path.endsWith('/jobs/run-one'))
      return Response.json({ id: 'run-one', nodeId: 'video-one', input })
  })
  renderApp(<ShotWorkbench />)
  expect(await screen.findByText('有参考图且实际送入模型')).toBeTruthy()
  expect(screen.queryByText('仅文字设定')).toBeNull()
})

it('对照只取采用视频同组的末帧，缺失时回退分镜图', async () => {
  const { doc } = fixture(true)
  const video = doc.get('video-one')!.results![0]!
  doc.mutable('video-one')!.set('results', [
    video,
    {
      ...video,
      id: 'tail',
      port: 'lastFrame',
      value: { type: 'image', assetId: 'b'.repeat(64) },
    },
  ])
  createElement(doc, {
    id: 'image-one',
    kind: 'node',
    nodeType: 'plein/image',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: { source: { storyboard: 'board', shot: 'one', role: 'image' } },
    results: [
      {
        id: 'still',
        port: 'image',
        runId: 'still-run',
        at: 1,
        value: { type: 'image', assetId: 'c'.repeat(64) },
      },
    ],
  })
  useCanvas.setState({ shotWorkbench: { boardId: 'board', shotId: 'two' } })
  workbenchReads(doc, [])
  renderApp(<ShotWorkbench />)
  expect((screen.getByAltText('视频末帧') as HTMLImageElement).src).toContain('b'.repeat(64))
  act(() => {
    doc.mutable('video-one')!.set('results', [video])
    doc.flush()
  })
  await waitFor(() =>
    expect((screen.getByAltText('分镜图') as HTMLImageElement).src).toContain('c'.repeat(64)),
  )
})

it('候选操作随镜头图、视频与采用状态变化', async () => {
  const { doc } = fixture()
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    const input = path.match(/\/nodes\/([^/]+)\/input$/)
    if (input) return Response.json(prepared(input[1]!, ''))
    if (path.endsWith('/jobs/latest')) return Response.json({ jobs: [] })
    if (path.endsWith('/jobs/image-run'))
      return Response.json({
        id: 'image-run',
        nodeId: 'image-one',
        input: prepared('image-one', ''),
      })
    if (path.endsWith('/jobs/video-run'))
      return Response.json({
        id: 'video-run',
        nodeId: 'video-one',
        input: prepared('video-one', ''),
      })
  })
  const { user } = renderApp(<ShotWorkbench />)
  expect(screen.getByRole('button', { name: '生成镜头图' })).toBeTruthy()
  act(() => {
    createElement(doc, {
      id: 'image-one',
      kind: 'node',
      nodeType: 'plein/image',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
      params: { source: { storyboard: 'board', shot: 'one', role: 'image' } },
      results: [
        {
          id: 'image-result',
          port: 'image',
          runId: 'image-run',
          at: 1,
          value: { type: 'image', assetId: 'c'.repeat(64) },
        },
      ],
    })
    doc.flush()
  })
  await waitFor(() => expect(screen.getByRole('button', { name: '生成视频' })).toBeTruthy())
  act(() => {
    createElement(doc, {
      id: 'video-one',
      kind: 'node',
      nodeType: 'plein/video',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
      params: { source: { storyboard: 'board', shot: 'one', role: 'video' } },
      results: [
        {
          id: 'video-result',
          port: 'video',
          runId: 'video-run',
          at: 1,
          value: { type: 'video', assetId: 'a'.repeat(64) },
        },
      ],
      adopted: null,
    })
    doc.flush()
  })
  await waitFor(() => expect(screen.getByRole('button', { name: '采用候选' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '采用候选' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '审阅' })).toBeTruthy())
  await user.click(screen.getByRole('button', { name: '审阅' }))
  expect(screen.getByLabelText('创作验收备注 · video-one')).toBeTruthy()
})

function addActor(doc: PleinDoc, profile?: unknown) {
  createElement(doc, {
    id: 'actor',
    kind: 'node',
    nodeType: 'plein/character',
    name: '角色',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: profile ? { profile } : {},
  })
}

function bindCharacter(
  doc: PleinDoc,
  board: string,
  shots: ReturnType<typeof rows>,
  prompt: string,
) {
  setParam(doc, board, 'shots', [
    { ...shots[0]!, characters: ['角色'], assetBindings: { 角色: { elementId: 'actor' } } },
    shots[1]!,
  ])
  setParam(doc, 'video-one', 'prompt', prompt)
}

const youngProfile = {
  periods: [
    {
      id: 'young',
      name: '青年',
      aliases: [],
      description: '',
      images: [],
      voice: null,
      voiceStates: [],
      outfits: [],
    },
  ],
  expressions: [],
}

function summaryInput(nodeId: string, prompt: string, sent: string[]): PreparedInput {
  const input = prepared(nodeId, prompt)
  input.refs = [
    {
      elementId: 'actor',
      name: '角色',
      kind: 'character',
      required: false,
      available: ['ref'],
      sent,
    },
  ]
  if (sent.length)
    input.inputs = { images: [{ type: 'image', assetId: sent[0]!, source: 'actor' }] }
  return input
}

function mockSummary(input: PreparedInput) {
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/input')) return Response.json(input)
    if (path.endsWith('/jobs/latest')) return Response.json({ jobs: [] })
    if (path.endsWith('/jobs/run-one'))
      return Response.json({ id: 'run-one', nodeId: 'video-one', input })
  })
}

it('摘要提示需要选择：档案项写错、多处引用都不猜；没提及时显示默认', async () => {
  const { doc, board, shots } = fixture(true)
  addActor(doc, youngProfile)
  bindCharacter(doc, board, shots, '@角色/老年')
  mockSummary(summaryInput('video-one', '@角色/老年', []))
  renderApp(<ShotWorkbench />)
  expect(await screen.findByText('档案项需要选择')).toBeTruthy()
  act(() => {
    setParam(doc, 'video-one', 'prompt', '@角色 @角色')
    doc.flush()
  })
  await waitFor(() =>
    expect(screen.getByText('档案项需要选择').closest('button')?.getAttribute('title')).toContain(
      '多处引用',
    ),
  )
  act(() => {
    setParam(doc, 'video-one', 'prompt', '天台夜戏，没有引用')
    doc.flush()
  })
  await waitFor(() => expect(screen.getByText(/时期：默认/)).toBeTruthy())
  expect(screen.queryByText('档案项需要选择')).toBeNull()
})

it('摘要按已有字段区分仅文字设定与已人工认可', async () => {
  const { doc, board, shots } = fixture(true)
  createElement(doc, {
    id: 'actor',
    kind: 'node',
    nodeType: 'plein/character',
    name: '角色',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    params: {},
    results: [
      {
        id: 'ref',
        port: 'image',
        runId: 'ref-run',
        at: 1,
        value: { type: 'image', assetId: 'd'.repeat(64) },
      },
    ],
  })
  expect(
    recordCreativeReview(doc, 'actor', {
      target: { kind: 'image', assetId: 'd'.repeat(64), resultId: 'ref' },
      status: 'usable',
    }),
  ).toBeTruthy()
  bindCharacter(doc, board, shots, '@角色')
  mockSummary(summaryInput('video-one', '@角色', []))
  renderApp(<ShotWorkbench />)
  expect(await screen.findByText('仅文字设定')).toBeTruthy()
  expect(screen.getByText('已人工认可')).toBeTruthy()
  expect(screen.queryByText('有参考图且实际送入模型')).toBeNull()
})

it('对照观察绑定候选：当前候选有观察则计数，换候选后提示重新审阅', async () => {
  const { doc } = fixture(true)
  const scope = { canvasId: 'canvas', boardId: 'board' }
  const subjectId = registerContinuitySubject(doc, {
    scope,
    kind: 'character',
    label: '主角',
  })!
  expect(
    recordContinuityObservation(doc, {
      scope,
      shotId: 'one',
      phase: 'end',
      nodeId: 'video-one',
      port: 'video',
      target: { kind: 'video', assetId: 'a'.repeat(64), resultId: 'candidate-one' },
      evidence: {
        kind: 'frame',
        position: 'end',
        frameAssetId: 'f'.repeat(64),
        aspects: ['visual'],
      },
      states: { [subjectId]: { condition: { certainty: 'unknown', note: '手持道具' } } },
      origin: { kind: 'manual', userId: 'local' },
    }),
  ).toBeTruthy()
  useCanvas.setState({ shotWorkbench: { boardId: 'board', shotId: 'two' } })
  workbenchReads(doc, [])
  renderApp(<ShotWorkbench />)
  expect(await screen.findByText('已记录 1 条衔接观察')).toBeTruthy()
  act(() => {
    doc.mutable('video-one')!.set('adopted', null)
    doc.flush()
  })
  await waitFor(() => expect(screen.getByText('候选已换，请重新审阅')).toBeTruthy())
})
