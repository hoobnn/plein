// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, writeRun, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog, PreparedInput } from '@plein/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useDocVersion } from '../../canvas/hooks'
import { useCancelRequests } from '../runs/cancelRequests'
import { useRunRequests } from '../runs/runRequests'
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
import { GeneratorPanel } from './Generator'

resetStoreAfterEach(useRunRequests)
resetStoreAfterEach(useCancelRequests)
const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const catalog = {
  providers: [
    {
      id: 'p/mock',
      plugin: 'p/mock',
      title: 'Mock',
      enabled: true,
      configured: true,
      credentialCount: 1,
      settingsSchema: {},
      secrets: [],
      models: [{ id: 'image', title: 'Mock 图片', capabilities: ['image.generate'] }],
    },
  ],
  nodes: [],
  templates: [],
  prompts: [],
  plugins: [],
  defaultModels: {},
} as unknown as Catalog

const node = {
  ...describeNode(
    corePlugin.nodes.find((n) => n.type === 'plein/image')!,
    'plein/core',
  ),
  executable: true,
}

/** 真实文档 + 引擎，画布上放一个生成图片节点 */
function setup() {
  vi.useFakeTimers()
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    name: '受理等待图片',
    x: 100,
    y: 100,
    w: 200,
    h: 120,
    params: { prompt: '透明水杯', model: 'p/mock:image' },
    ports: { inputs: node.inputs, outputs: node.outputs },
  })
  const subscribe = () => () => {}
  const engine = {
    doc,
    selection: { set: vi.fn(), values: () => [], has: () => true, onChange: subscribe },
    onStateChange: subscribe,
    onViewChange: subscribe,
    onMove: subscribe,
    onActivate: subscribe,
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
    visibleIds: [],
    highDetail: false,
    camera: {
      onChange: subscribe,
      onInsetsChange: subscribe,
      insets: { left: 0, right: 0, top: 0, bottom: 0 },
      width: 1000,
      height: 800,
      zoom: 1,
      viewRect: { x: 0, y: 0, w: 1000, h: 800 },
      worldToScreen: (x: number, y: number) => ({ x, y }),
      centerOn: vi.fn(),
    },
    worldToClient: (x: number, y: number) => ({ x, y }),
    state: { tool: 'select' },
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas' })
  return { doc, id, engine }
}

interface RunHandlers {
  /** 第一次运行请求是否延迟应答 */
  delay?: boolean
  firstStatus?: number
  firstBody?: unknown
}

function serveRun(
  nodeId: string,
  { delay = false, firstStatus = 202, firstBody = { runId: 'run-1' } }: RunHandlers = {},
) {
  const calls: string[] = []
  let release!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  const fetch = mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/run')) {
      calls.push(path)
      if (calls.length === 1 && delay)
        return gate.then(() => Response.json(firstBody as never, { status: firstStatus as 202 }))
      return Response.json({ runId: 'run-1' }, { status: 202 })
    }
    if (request.method === 'POST' && path.endsWith('/cancel'))
      return Response.json({ ok: true }, { status: 202 })
    if (path.endsWith('/input'))
      return Response.json({
        v: 1,
        nodeId,
        nodeType: 'plein/image',
        preparedAt: 1,
        status: 'ready',
        inputHash: 'hash-1',
        inputs: {},
        params: {},
        prompt: '透明水杯',
        refs: [],
        blocked: [],
        notices: [],
        media: [],
        texts: [],
      })
    return undefined
  })
  return { fetch, calls, release: (r: Response) => release(r) }
}

function renderPanel(id: string, engine: Engine) {
  function Harness() {
    useDocVersion(engine.doc)
    return <GeneratorPanel engine={engine} el={engine.doc.get(id)!} node={node} catalog={catalog} />
  }
  return renderApp(<Harness />)
}

const runButton = () => screen.getByRole('button', { name: '生成' })

describe('生成受理等待与取消', () => {
  it('等待应答期间按钮与快捷键共享同一次提交，不会重复发请求', async () => {
    const { id, engine } = setup()
    const { calls, release } = serveRun(id, { delay: true })
    renderPanel(id, engine)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(true))
    expect(runButton().getAttribute('aria-busy')).toBe('true')

    // 等待期间按快捷键：不能再发一次请求
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter', metaKey: true })
    })
    expect(calls).toHaveLength(1)

    release(Response.json({ runId: 'run-1' }, { status: 202 }))
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
  })

  it('重开生成器仍保留等待状态与新草稿，不会再发一次请求', async () => {
    const { id, engine } = setup()
    const { calls, release } = serveRun(id, { delay: true })
    const view = renderPanel(id, engine)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(true))

    // 等待期间改了提示词：草稿要留下
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '等待期间继续编辑的蓝色水杯' },
    })

    // 关掉面板再打开
    view.unmount()
    renderPanel(id, engine)
    await waitFor(() =>
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' }).value).toBe(
        '等待期间继续编辑的蓝色水杯',
      ),
    )
    // 还在等待：按钮仍然是禁用的，没有再提交一次
    expect((runButton() as HTMLButtonElement).disabled).toBe(true)
    expect(calls).toHaveLength(1)

    release(Response.json({ runId: 'run-1' }, { status: 202 }))
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    expect(calls).toHaveLength(1)
  })

  it('提交失败后恢复可生成，并能真正再跑一次', async () => {
    const { id, engine } = setup()
    const { calls, release } = serveRun(id, {
      delay: true,
      firstStatus: 503,
      firstBody: { error: 'submit_wait', message: '生成受理暂不可用' },
    })
    renderPanel(id, engine)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(true))
    release(Response.json({ error: 'submit_wait', message: '生成受理暂不可用' }, { status: 503 }))

    // 失败后按钮恢复可用
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))

    // 再点一次：这次真的发出请求
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect(calls.length).toBeGreaterThan(1))
  })

  it('运行已受理但应答没回来时仍可取消，不被提交等待锁住', async () => {
    const { id, engine } = setup()
    const { calls, release } = serveRun(id, { delay: true })
    renderPanel(id, engine)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(true))

    // 受理之后：服务端已受理、应答还没回来，节点进入运行中。
    // 提交请求仍在等待应答（submitting 为真），这时取消必须仍然可用：
    // 受理之后就归运行管了，不能被「等待应答」锁住。
    await act(async () => {
      writeRun(engine.doc, id, { id: 'run-1', status: 'running', at: Date.now() })
      engine.doc.flush()
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeTruthy())
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(false)
    expect(calls).toHaveLength(1)

    // 应答最终会回来，别把请求留在未结算状态
    release(Response.json({ runId: 'run-1' }, { status: 202 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    await waitFor(() => expect(calls).toHaveLength(1))
  })
})

const promptBox = () => screen.getByRole('textbox', { name: '提示词' })
const typePrompt = (doc: PleinDoc, value: string) => {
  fireEvent.change(promptBox(), { target: { value } })
  // 测试文档的 schedule 是空操作：显式 flush 才通知订阅者
  act(() => doc.flush())
}

interface DeferredPreview {
  prompt: string
  signal: AbortSignal
  resolve(input: PreparedInput): void
}

/** 预览请求由用例控制返回顺序；运行请求只记账 */
function servePreviews(id: string, doc: PleinDoc) {
  const runs: Array<Record<string, unknown>> = []
  const previews: DeferredPreview[] = []
  const fetch = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/run')) {
      runs.push(JSON.parse(await request.text()) as never)
      return Response.json({ runId: 'run-1' }, { status: 202 })
    }
    if (request.method === 'POST' && path.endsWith('/input'))
      return new Promise<Response>((resolve) =>
        previews.push({
          prompt: String(doc.get(id)?.params?.prompt ?? ''),
          signal: request.signal,
          resolve: (input) => resolve(Response.json(input)),
        }),
      )
    return undefined
  })
  // 被新一次预览取代的请求仍留在数组里，但已经取消
  const live = () => previews.filter((preview) => !preview.signal.aborted)
  return { fetch, runs, live }
}

const readyInput = (nodeId: string, prompt: string, inputHash: string) => ({
  v: 1,
  nodeId,
  nodeType: 'plein/image',
  preparedAt: 1,
  status: 'ready',
  inputHash,
  inputs: {},
  params: {},
  prompt,
  refs: [],
  blocked: [],
  notices: [],
  media: [],
  texts: [],
})

describe('等待预览期间的运行授权', () => {
  it('首次预览还没回来时点击，改成新输入后原授权作废；重新确认只提交一次', async () => {
    const { id, engine, doc } = setup()
    const { runs, live } = servePreviews(id, doc)
    renderPanel(id, engine)
    // 首次读取立即发起，还没有结果：按钮可用
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(live().map((p) => p.prompt)).toEqual(['透明水杯'])
    expect((runButton() as HTMLButtonElement).disabled).toBe(false)

    // 点击时授权的是「透明水杯」这一版
    await act(async () => {
      runButton().click()
    })
    typePrompt(doc, '雨后的天台')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(live().map((p) => p.prompt)).toEqual(['雨后的天台'])

    // 用户又改成另一版：点击时授权的那一版已经被替换
    typePrompt(doc, '清晨的天台')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(live().map((p) => p.prompt)).toEqual(['清晨的天台'])
    await act(async () => live()[0]!.resolve(readyInput(id, '清晨的天台', 'hash-2') as never))

    // 输入变了，原授权作废：没有提交，界面上说清楚了
    expect(runs).toHaveLength(0)
    expect(await screen.findByText(/输入已修改，这次生成已取消/)).toBeTruthy()

    // 用户再次明确运行：只提交一次，带上当前新预览的哈希
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0]).toMatchObject({ expect: 'hash-2' })
  })

  it('快捷键与按钮重复按下时，输入没变就只提交一次', async () => {
    const { id, engine } = setup()
    const { runs, live } = servePreviews(id, engine.doc)
    renderPanel(id, engine)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(live()).toHaveLength(1)
    // 快捷键和按钮记的是同一次生成
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('generator'), { key: 'Enter', metaKey: true })
      runButton().click()
      runButton().click()
    })
    expect(runs).toHaveLength(0)
    await act(async () => live()[0]!.resolve(readyInput(id, '透明水杯', 'hash-1') as never))
    await waitFor(() => expect(runs).toHaveLength(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ expect: 'hash-1' })
  })

  it('关掉生成器后，迟到的预览不会补提交', async () => {
    const { id, engine } = setup()
    const { runs, live } = servePreviews(id, engine.doc)
    const view = renderPanel(id, engine)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      runButton().click()
    })
    const pending = live()[0]!
    view.unmount()
    // 已经取消的请求迟到的应答不能再提交
    await act(async () => pending.resolve(readyInput(id, '透明水杯', 'hash-1') as never))
    expect(runs).toHaveLength(0)

    // 重新打开后要重新确认
    renderPanel(id, engine)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(live()).toHaveLength(1)
    await act(async () => live()[0]!.resolve(readyInput(id, '透明水杯', 'hash-1') as never))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect(runs).toHaveLength(1))
  })

  it('服务端说输入已变时不自行提交带回的新输入', async () => {
    const { id, engine } = setup()
    const runs: Array<Record<string, unknown>> = []
    mockFetch(async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'POST' && path.endsWith('/run')) {
        runs.push(JSON.parse(await request.text()) as never)
        return Response.json(
          {
            error: 'input_changed',
            message: '实际输入在预览后变了，请确认后再生成',
            input: readyInput(id, '服务端的新输入', 'hash-9'),
          },
          { status: 409 },
        )
      }
      if (request.method === 'POST' && path.endsWith('/input'))
        return Response.json(readyInput(id, '透明水杯', 'hash-1'))
      return undefined
    })
    renderPanel(id, engine)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect(runs).toHaveLength(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // 只提交了用户确认的那一次，没有拿新回执自动再跑
    expect(runs).toHaveLength(1)
    await act(async () => {
      runButton().click()
    })
    await waitFor(() => expect(runs).toHaveLength(2))
  })
})

it('连接一直正常但服务端两次未追平时，自动退避重读，追平后直接可用且不提交', async () => {
  const { id, engine } = setup()
  const runs: string[] = []
  let inputs = 0
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/run')) {
      runs.push(await request.text())
      return Response.json({ runId: 'run-1' }, { status: 202 })
    }
    if (request.method === 'POST' && path.endsWith('/input')) {
      inputs++
      if (inputs <= 2)
        return Response.json(
          { error: 'sync_pending', message: '本机改动还没有同步到服务端，请等同步完成后再操作' },
          { status: 409 },
        )
      return Response.json(readyInput(id, '追平后的输入', 'hash-9'))
    }
    return undefined
  })
  renderPanel(id, engine)
  // 连接状态一直不变：只靠预览自己的退避重试恢复
  await act(async () => {
    useCanvas.setState({ sync: 'connected' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(inputs).toBe(1)
  expect(screen.getAllByText(/本机改动还没有同步到服务端/).length).toBeGreaterThan(0)
  expect((runButton() as HTMLButtonElement).disabled).toBe(true)

  // 第一次 409 后 300ms 重读，第二次后 600ms 再重读
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
  expect(inputs).toBe(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(inputs).toBe(3)
  await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
  // 追平后直接显示新输入，不需要点「重新读取」，也没有替用户提交
  expect(screen.queryByText(/本机改动还没有同步到服务端/)).toBeNull()
  await act(async () => {
    screen.getByRole('button', { name: /实际输入/ }).click()
  })
  expect(screen.getByTestId('final-prompt').textContent).toContain('追平后的输入')
  expect(runs).toHaveLength(0)

  await act(async () => {
    runButton().click()
  })
  await waitFor(() => expect(runs).toHaveLength(1))
  expect(JSON.parse(runs[0]!) as Record<string, unknown>).toMatchObject({ expect: 'hash-9' })
})

it('服务端还没收到本机改动时预览等同步，同步后重新读取才允许生成', async () => {
  const { id, engine } = setup()
  const runs: string[] = []
  let pending = true
  const fetch = mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/run')) {
      runs.push(await request.text())
      return Response.json({ runId: 'run-1' }, { status: 202 })
    }
    if (request.method === 'POST' && path.endsWith('/input'))
      return pending
        ? Response.json(
            { error: 'sync_pending', message: '本机改动还没有同步到服务端，请等同步完成后再操作' },
            { status: 409 },
          )
        : Response.json(readyInput(id, '透明水杯', 'hash-1'))
    return undefined
  })
  renderPanel(id, engine)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  await waitFor(() =>
    expect(screen.getAllByText(/本机改动还没有同步到服务端/).length).toBeGreaterThan(0),
  )
  expect((runButton() as HTMLButtonElement).disabled).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)

  // 同步恢复：重新读取实际输入，这份输入才能用来提交
  pending = false
  await act(async () => {
    useCanvas.setState({ sync: 'connected' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await waitFor(() => expect((runButton() as HTMLButtonElement).disabled).toBe(false))
  await act(async () => {
    runButton().click()
  })
  await waitFor(() => expect(runs).toHaveLength(1))
  expect(JSON.parse(runs[0]!) as Record<string, unknown>).toMatchObject({ expect: 'hash-1' })
})

it('失败记录明确标为上次结果，不把当前可运行输入标为失败', async () => {
  const { id, engine } = setup()
  serveRun(id)
  writeRun(engine.doc, id, {
    id: 'old-run',
    status: 'failed',
    at: 1,
    error: '视频提示词须为 1–7000 字符',
  })
  renderPanel(id, engine)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(screen.getByText(/上次生成失败：视频提示词须为 1–7000 字符/)).toBeTruthy()
  expect(screen.getByText(/此为历史结果，当前输入请以「实际输入」为准/)).toBeTruthy()
  expect((runButton() as HTMLButtonElement).disabled).toBe(false)
})
