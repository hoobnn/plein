// @vitest-environment happy-dom
import { CaptionLayerParams } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen } from '../../testing/render'
import { CaptionPreview } from './CaptionPreview'
import { Playhead } from './playhead'
import type { Window as HappyWindow } from 'happy-dom'

const settings = (window as unknown as HappyWindow).happyDOM.settings
const originalLoading = {
  enableIframePageLoading: settings.enableIframePageLoading,
  disableIframePageLoading: settings.disableIframePageLoading,
}
afterEach(() => {
  Object.assign(settings, originalLoading)
})

it('字幕会话创建中关闭，迟到响应立即释放，重新打开可用且受主时钟控制', async () => {
  Object.assign(settings, { enableIframePageLoading: true, disableIframePageLoading: false })
  vi.useFakeTimers()
  const frames = new WeakMap<HTMLIFrameElement, { postMessage: ReturnType<typeof vi.fn> }>()
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (
    this: HTMLIFrameElement,
  ) {
    if (!frames.has(this)) frames.set(this, { postMessage: vi.fn() })
    return frames.get(this) as unknown as Window
  })
  const setAttribute = HTMLIFrameElement.prototype.setAttribute
  vi.spyOn(HTMLIFrameElement.prototype, 'setAttribute').mockImplementation(function (
    this: HTMLIFrameElement,
    name,
    value,
  ) {
    setAttribute.call(this, name === 'src' ? 'data-preview-url' : name, value)
  })
  let release!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  const deleted: string[] = []
  let creates = 0
  const session = (id: string) => ({
    id,
    nonce: `nonce-${id}`,
    origin: 'http://127.0.0.1:8877',
    url: `http://127.0.0.1:8877/${id}`,
    expiresAt: Date.now() + 60000,
    duration: 3,
  })
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/motion/preview/captions')
      return ++creates === 1 ? gate : Response.json(session('second'))
    if (request.method === 'DELETE') {
      deleted.push(path)
      return new Response(null, { status: 204 })
    }
  })
  const head = new Playhead()
  head.setTotal(3)
  const params = CaptionLayerParams.parse({
    width: 160,
    height: 90,
    duration: 3,
    cues: [{ start: 0, end: 1, text: '字幕' }],
  })
  const first = renderApp(<CaptionPreview params={params} playhead={head} />)
  await act(() => vi.advanceTimersByTimeAsync(180))
  first.unmount()
  await act(async () => {
    release(Response.json(session('first')))
    await gate
  })
  expect(deleted).toEqual(['/api/motion/preview/first'])
  expect(screen.queryByTitle('动画字幕隔离预览')).toBeNull()
  const second = renderApp(<CaptionPreview params={params} playhead={head} />)
  await act(() => vi.advanceTimersByTimeAsync(180))
  const frame = screen.getByTitle('动画字幕隔离预览') as HTMLIFrameElement
  const send = vi.spyOn(frame.contentWindow!, 'postMessage')
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: session('second').origin,
        source: frame.contentWindow,
        data: { type: 'plein-motion-event', id: 'second', nonce: 'nonce-second', event: 'ready' },
      }),
    )
  })
  expect(frame.style.visibility).toBe('visible')
  expect(send.mock.calls.map(([message]) => message.command)).toEqual(['pause', 'seek'])
  act(() => head.seek(1))
  expect(send).toHaveBeenLastCalledWith(
    expect.objectContaining({ command: 'seek', time: 1 }),
    session('second').origin,
  )
  second.unmount()
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(deleted).toEqual(['/api/motion/preview/first', '/api/motion/preview/second'])
  head.dispose()
})
