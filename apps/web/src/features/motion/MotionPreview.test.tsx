// @vitest-environment happy-dom
import { MotionParams } from '@plein/nodes'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen } from '../../testing/render'
import { MotionPreview } from './MotionPreview'
import type { MotionPreviewSession } from './api'

// happy-dom 不加载隔离文档，只替换消息传输边界，仍执行真实请求和会话生命周期。
beforeEach(() => {
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
    if (name === 'src') setAttribute.call(this, 'srcdoc', '')
    setAttribute.call(this, name === 'src' ? 'data-preview-url' : name, value)
  })
})

const params = MotionParams.parse({ duration: 6 })
const session = (id: string): MotionPreviewSession => ({
  id,
  nonce: `nonce-${id}`,
  origin: 'http://127.0.0.1:8877',
  url: `http://127.0.0.1:8877/${id}`,
  expiresAt: Date.now() + 60_000,
})
function event(id: string, event: string, extra: Record<string, unknown> = {}) {
  const frame = screen.getByTitle('动态合成隔离预览') as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: session(id).origin,
        source: frame.contentWindow,
        data: { type: 'plein-motion-event', id, nonce: session(id).nonce, event, ...extra },
      }),
    )
  })
}
function setup() {
  vi.useFakeTimers()
  const bodies: unknown[] = [],
    deleted: string[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path === '/api/motion/preview') {
      bodies.push(await request.json())
      return Response.json(session(String(bodies.length)))
    }
    if (request.method === 'DELETE' && path.startsWith('/api/motion/preview/')) {
      deleted.push(path.split('/').at(-1)!)
      return new Response(null, { status: 204 })
    }
  })
  const view = renderApp(<MotionPreview params={params} inputs={{}} active />)
  return { ...view, bodies, deleted }
}
const tick = (ms = 180) => act(() => vi.advanceTimersByTimeAsync(ms))

it('隔离消息验证身份；拖动先暂停真实播放器，播放到片尾后从头重播', async () => {
  const f = setup()
  await tick()
  const frame = screen.getByTitle('动态合成隔离预览') as HTMLIFrameElement
  const send = vi.spyOn(frame.contentWindow!, 'postMessage')
  event('wrong', 'ready')
  expect((screen.getByRole('button', { name: '播放预览' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  event('1', 'ready')
  event('1', 'play')
  event('1', 'timeupdate', { time: 3 })
  send.mockClear()
  fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } })
  expect(send.mock.calls.map(([message]) => message.command)).toEqual(['pause', 'seek'])
  expect(send.mock.calls[1]?.[0]).toMatchObject({ time: 2, id: '1', nonce: 'nonce-1' })
  event('1', 'timeupdate', { time: 6 })
  event('1', 'ended')
  send.mockClear()
  await f.user.click(screen.getByRole('button', { name: '播放预览' }))
  expect(send.mock.calls.map(([message]) => message.command)).toEqual(['seek', 'play'])
  expect(send.mock.calls[0]?.[0].time).toBe(0)
  f.unmount()
  await tick(0)
  expect(f.deleted).toEqual(['1'])
})

it('预览未就绪超时后可重试，成功后恢复控件且不遗留超时', async () => {
  const f = setup()
  await tick()
  await tick(20_000)
  expect(screen.getAllByText('预览加载超时，请重试预览').length).toBeGreaterThan(0)
  await f.user.click(screen.getByRole('button', { name: '重试预览' }))
  await tick()
  expect(f.deleted).toEqual(['1'])
  event('2', 'ready')
  await tick(20_000)
  expect(screen.queryByRole('button', { name: '重试预览' })).toBeNull()
  expect((screen.getByRole('button', { name: '播放预览' }) as HTMLButtonElement).disabled).toBe(
    false,
  )
  f.unmount()
  await tick(0)
})

it('输入身份变化重建会话，恢复播放位置；相同输入不重复请求', async () => {
  const f = setup()
  await tick()
  event('1', 'ready')
  event('1', 'timeupdate', { time: 3.5 })
  event('1', 'play')
  f.rerender(<MotionPreview params={{ ...params }} inputs={{}} active />)
  await tick()
  expect(f.bodies).toHaveLength(1)
  f.rerender(<MotionPreview params={params} inputs={{ image: 'a'.repeat(64) }} active />)
  await tick()
  const frame = screen.getByTitle('动态合成隔离预览') as HTMLIFrameElement
  const send = vi.spyOn(frame.contentWindow!, 'postMessage')
  event('2', 'ready')
  expect(send.mock.calls.map(([message]) => message.command)).toEqual(['seek', 'play'])
  expect(send.mock.calls[0]?.[0].time).toBe(3.5)
  expect(f.bodies).toEqual([
    { params, inputs: {} },
    { params, inputs: { image: 'a'.repeat(64) } },
  ])
  expect(f.deleted).toEqual(['1'])
  f.unmount()
  await tick(0)
})

it('关闭后迟到的创建响应立即释放，不挂载预览', async () => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  const deleted: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path === '/api/motion/preview')
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    if (request.method === 'DELETE') {
      deleted.push(path)
      return new Response(null, { status: 204 })
    }
  })
  const f = renderApp(<MotionPreview params={params} inputs={{}} active />)
  await tick()
  f.unmount()
  await act(async () => {
    release(Response.json(session('late')))
  })
  expect(deleted).toEqual(['/api/motion/preview/late'])
  expect(screen.queryByTitle('动态合成隔离预览')).toBeNull()
})
