// @vitest-environment happy-dom
import { type Engine, Selection } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { SelectionBar } from './SelectionBar'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

/** 真实文档与真实选区；只补齐浮动面板定位需要的引擎方法。 */
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const selection = new Selection()
  const engine = {
    doc,
    selection,
    camera: {
      insets: { left: 0, right: 0, top: 0, bottom: 0 },
      onInsetsChange: () => () => {},
    },
    scene: { rect: (id: string) => doc.worldRect(id) },
    worldToClient: (x: number, y: number) => ({ x, y }),
    onMove: () => () => {},
    onStateChange: () => () => {},
  } as unknown as Engine
  return { doc, engine, selection }
}

const image = (doc: PleinDoc, name: string, assetId: string, parentId?: string) =>
  createElement(doc, {
    kind: 'image',
    name,
    assetId,
    parentId,
    x: 0,
    y: 0,
    w: 200,
    h: 150,
  })

/** 记录交给浏览器的文件名；指定资产挂在未决请求上，等用例自己放行或取消。 */
function downloads(heldAsset?: string) {
  const files: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    files.push(this.download)
  })
  const reads: { path: string; signal: AbortSignal }[] = []
  let release!: (response: Response) => void
  let held = true
  mockFetch((request) => {
    const url = new URL(request.url)
    // 媒体能力是工具条自己问的，与下载队列无关。
    if (url.pathname === '/api/media/caps')
      return Response.json({ ffmpeg: false, subtitles: false, rubberband: false })
    if (!url.pathname.startsWith('/api/assets/')) return undefined
    reads.push({ path: url.pathname, signal: request.signal })
    if (heldAsset && url.pathname.endsWith(`/${heldAsset}`) && held)
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    return new Response('bytes', {
      headers: { 'content-type': url.pathname.endsWith('/a') ? 'image/png' : 'audio/wav' },
    })
  })
  return {
    files,
    reads,
    release: (response: Response) => release(response),
    settle: () => {
      held = false
    },
  }
}

describe('多选下载的组件接线', () => {
  it('清空选区后仍能取消，取消后能继续下载未交出的原文件', async () => {
    vi.useFakeTimers()
    const f = fixture()
    useCanvas.setState({ engine: f.engine, canvasId: 'canvas-1' })
    const a = image(f.doc, '原图片-1', 'a')
    const b = image(f.doc, '原音频-2', 'b')
    f.selection.set([a, b])
    const d = downloads('b')
    const { user } = renderApp(<SelectionBar remote />)

    await user.click(screen.getByRole('button', { name: /^下载/ }))
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(d.files).toEqual(['原图片-1.png'])

    // 下载进行中清空选区：多选工具条换成下载工具条，取消入口仍在
    act(() => f.selection.clear())
    await waitFor(() => expect(screen.getByRole('toolbar', { name: '下载操作' })).toBeTruthy())
    expect(screen.queryByRole('toolbar', { name: '多选操作' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '取消下载' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /继续下载/ })).toBeTruthy())
    expect(d.reads.at(-1)!.signal.aborted).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('1 个文件未下载')

    // 继续下载只补未交出的那份，已交出的不重复下载
    d.settle()
    await user.click(screen.getByRole('button', { name: /继续下载/ }))
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(d.files).toEqual(['原图片-1.png', '原音频-2.wav'])
    expect(d.reads.map((read) => read.path)).toEqual([
      '/api/assets/a',
      '/api/assets/b',
      '/api/assets/b',
    ])
    await act(() => vi.advanceTimersByTimeAsync(1000))
  })

  it.each(['canvas', 'unmount'] as const)('%s 中断读取，旧画布的结果不写进新画布', async (mode) => {
    vi.useFakeTimers()
    const f = fixture()
    useCanvas.setState({ engine: f.engine, canvasId: 'canvas-1' })
    const a = image(f.doc, '原图片-1', 'a')
    const b = image(f.doc, '原音频-2', 'b')
    f.selection.set([a, b])
    const d = downloads('b')
    const { user, rerender } = renderApp(<SelectionBar remote />)

    await user.click(screen.getByRole('button', { name: /^下载/ }))
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(d.files).toEqual(['原图片-1.png'])

    // 导航到另一张画布，或整个工具条被卸载
    if (mode === 'canvas') {
      const other = fixture()
      useCanvas.setState({ engine: other.engine, canvasId: 'canvas-2' })
    } else {
      rerender(<></>)
    }
    await waitFor(() => expect(d.reads.at(-1)!.signal.aborted).toBe(true))
    await act(async () => d.release(new Response('late')))
    expect(d.files).toEqual(['原图片-1.png'])
    // 新画布不继承旧画布的下载状态
    expect(screen.queryByRole('toolbar', { name: '下载操作' })).toBeNull()
    expect(screen.queryByRole('button', { name: /继续下载|重试未下载/ })).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1000))
  })

  it('分组与它的后代同时选中时只下载一份', async () => {
    vi.useFakeTimers()
    const f = fixture()
    useCanvas.setState({ engine: f.engine, canvasId: 'canvas-1' })
    const frame = createElement(f.doc, { kind: 'frame', name: '分组', x: 0, y: 0, w: 600, h: 400 })
    const child = image(f.doc, '组内图片', 'a', frame)
    f.selection.set([frame, child])
    const d = downloads()
    const { user } = renderApp(<SelectionBar remote />)

    // 分组本身没有素材，只有后代那份：后代的图不能被数成两份
    expect(screen.getByRole('button', { name: '下载（1）' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '下载（1）' }))
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(d.files).toEqual(['组内图片.png'])
    expect(d.reads.map((read) => read.path)).toEqual(['/api/assets/a'])
    await act(() => vi.advanceTimersByTimeAsync(1000))
  })
})
