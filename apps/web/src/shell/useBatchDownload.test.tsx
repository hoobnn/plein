// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { useBatchDownload } from './useBatchDownload'
import { shellFixture } from './testing'

const items = [
  { assetId: 'a', name: '原图片-1' },
  { assetId: 'b', name: '原音频-2' },
]
function Harness({
  engine,
  enabled = true,
  queue = items,
}: {
  engine: Engine
  enabled?: boolean
  queue?: typeof items
}) {
  const download = useBatchDownload(engine, enabled)
  return (
    <>
      <button type="button" onClick={() => void download.start(queue)}>
        下载
      </button>
      <button type="button" onClick={download.cancel}>
        取消
      </button>
      <button type="button" onClick={() => void download.start(download.remaining)}>
        重试
      </button>
      <output>{JSON.stringify(download)}</output>
    </>
  )
}
function setup() {
  vi.useFakeTimers()
  const f = shellFixture()
  const files: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    files.push(this.download)
  })
  const rendered = renderApp(<Harness engine={f.engine} />)
  const state = () => JSON.parse(screen.getByRole('status').textContent!)
  return { ...f, ...rendered, files, state }
}
const bytes = (request: Request) =>
  new Response(request.url.endsWith('/a') ? 'image-bytes' : 'audio-bytes', {
    headers: { 'content-type': request.url.endsWith('/a') ? 'image/png' : 'audio/wav' },
  })

it('失败只重试原失败项，选择和标题变化不替换正在读取的队列', async () => {
  const f = setup()
  let fail = true
  const fetch = mockFetch((request) =>
    new URL(request.url).pathname.startsWith('/api/assets/')
      ? fail && request.url.endsWith('/a')
        ? Response.json({ error: '暂时不可用' }, { status: 503 })
        : bytes(request)
      : undefined,
  )
  await f.user.click(screen.getByRole('button', { name: '下载' }))
  f.rerender(<Harness engine={f.engine} queue={[{ assetId: 'other', name: '新选择' }]} />)
  await act(() => vi.advanceTimersByTimeAsync(250))
  expect(f.files).toEqual(['原音频-2.wav'])
  expect(f.state()).toMatchObject({ running: false, failed: 1, remaining: [items[0]] })
  fail = false
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  expect(f.files).toEqual(['原音频-2.wav', '原图片-1.png'])
  expect(
    fetch.mock.calls.map(
      ([request]) =>
        new URL(
          typeof request === 'string'
            ? request
            : request instanceof URL
              ? request.href
              : request.url,
          location.href,
        ).pathname,
    ),
  ).toEqual(['/api/assets/a', '/api/assets/b', '/api/assets/a'])
  expect(f.state()).toMatchObject({ running: false, done: 1, remaining: [] })
  await act(() => vi.advanceTimersByTimeAsync(1000))
})
it('同帧重复下载不重复读取；取消后仅继续未交出的原文件', async () => {
  const f = setup()
  let release!: (response: Response) => void
  let held = true
  const fetch = mockFetch((request) =>
    request.url.endsWith('/b') && held
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : bytes(request),
  )
  const button = screen.getByRole('button', { name: '下载' })
  act(() => {
    button.click()
    button.click()
  })
  await act(() => vi.advanceTimersByTimeAsync(250))
  expect(f.files).toEqual(['原图片-1.png'])
  expect(fetch).toHaveBeenCalledTimes(2)
  await f.user.click(screen.getByRole('button', { name: '取消' }))
  await act(async () => release(new Response('late')))
  expect(f.state()).toMatchObject({ cancelled: true, remaining: [items[1]] })
  held = false
  await f.user.click(screen.getByRole('button', { name: '重试' }))
  expect(f.files).toEqual(['原图片-1.png', '原音频-2.wav'])
  expect(fetch).toHaveBeenCalledTimes(3)
  await act(() => vi.advanceTimersByTimeAsync(1000))
})
it.each(['close', 'canvas'] as const)(
  '%s 中断读取，迟到文件不交出；重新打开不复活旧状态',
  async (mode) => {
    const f = setup()
    let release!: (response: Response) => void
    let signal!: AbortSignal
    mockFetch((request) => {
      signal = request.signal
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    await f.user.click(screen.getByRole('button', { name: '下载' }))
    if (mode === 'close') f.rerender(<Harness engine={f.engine} enabled={false} />)
    else act(() => useCanvas.setState({ canvasId: 'other' }))
    expect(signal.aborted).toBe(true)
    await act(async () => release(new Response('late')))
    expect(f.files).toEqual([])
    expect(f.state()).toMatchObject({ running: false, total: 0, remaining: [] })
    f.rerender(<Harness engine={f.engine} />)
    expect(f.state().total).toBe(0)
  },
)
it('取消后通知里的「继续下载」接着下载未交出的原文件，已交出的不重复读取', async () => {
  const f = setup()
  let held = true
  const fetch = mockFetch((request) =>
    request.url.endsWith('/b') && held ? new Promise<Response>(() => {}) : bytes(request),
  )
  await f.user.click(screen.getByRole('button', { name: '下载' }))
  await act(() => vi.advanceTimersByTimeAsync(250))
  expect(f.files).toEqual(['原图片-1.png'])

  // 取消后要给用户一个「继续下载」的入口，未交出的那份留在队列里
  await f.user.click(screen.getByRole('button', { name: '取消' }))
  await waitFor(() => expect(useCanvas.getState().noticeAction?.label).toBe('继续下载'))
  expect(useCanvas.getState().notice).toContain('已取消后续下载')
  expect(f.state()).toMatchObject({ running: false, cancelled: true, remaining: [items[1]] })

  held = false
  await act(async () => useCanvas.getState().noticeAction!.run())
  await waitFor(() => expect(f.files).toEqual(['原图片-1.png', '原音频-2.wav']))
  expect(
    fetch.mock.calls.map(
      ([request]) =>
        new URL(
          typeof request === 'string'
            ? request
            : request instanceof URL
              ? request.href
              : request.url,
          location.href,
        ).pathname,
    ),
  ).toEqual(['/api/assets/a', '/api/assets/b', '/api/assets/b'])
  await act(() => vi.advanceTimersByTimeAsync(1000))
})
it('关闭失败面板清理其通知与重试动作，不清理其他来源的新通知', async () => {
  const f = setup()
  mockFetch(() => Response.json({ error: '失败' }, { status: 503 }))
  await f.user.click(screen.getByRole('button', { name: '下载' }))
  await act(() => vi.advanceTimersByTimeAsync(250))
  expect(useCanvas.getState().noticeAction?.label).toBe('重试未下载')
  f.rerender(<Harness engine={f.engine} enabled={false} />)
  expect(useCanvas.getState().notice).toBeNull()
  f.rerender(<Harness engine={f.engine} />)
  await f.user.click(screen.getByRole('button', { name: '下载' }))
  await act(() => vi.advanceTimersByTimeAsync(250))
  act(() => useCanvas.getState().notify('其他操作已完成'))
  f.rerender(<Harness engine={f.engine} enabled={false} />)
  expect(useCanvas.getState().notice).toBe('其他操作已完成')
})
