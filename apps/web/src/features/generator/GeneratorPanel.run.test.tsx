// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, writeRun, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
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
  elements: [],
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
