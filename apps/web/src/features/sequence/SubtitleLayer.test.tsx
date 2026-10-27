// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { API } from '@plein/protocol'
import { mockResizeObserver } from '../../testing/browser'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, waitFor } from '../../testing/render'
import { Playhead } from './playhead'
import { SubtitleLayer } from './SubtitleLayer'

const doubles = vi.hoisted(() => ({
  instances: [] as Array<{
    renderer: { addFonts: ReturnType<typeof vi.fn>; setTrack: ReturnType<typeof vi.fn> }
    manualRender: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>,
}))
vi.mock('jassub', () => ({
  default: class {
    ready = Promise.resolve()
    renderer = { addFonts: vi.fn(async () => {}), setTrack: vi.fn(async () => {}) }
    manualRender = vi.fn(async () => {})
    resize = vi.fn(async () => {})
    destroy = vi.fn(async () => {})
    constructor() {
      doubles.instances.push(this)
    }
  },
}))
let head: Playhead
beforeEach(() => {
  doubles.instances.length = 0
  mockResizeObserver()
  vi.stubGlobal('OffscreenCanvas', class {})
  head = new Playhead()
  head.setTotal(10)
})
afterEach(() => head.dispose())
function render(build = () => '字幕一') {
  const onMode = vi.fn()
  const props = { build, width: 1280, height: 720, playhead: head, onMode }
  return { ...renderApp(<SubtitleLayer {...props} />), props, onMode }
}
function fonts(
  file: () => Response | Promise<Response> = () => new Response(new Uint8Array([1, 2, 3])),
) {
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === API.subtitleFont) return Response.json({ family: 'Test Sans', version: 'test' })
    if (path === new URL(API.subtitleFontFile('test'), location.origin).pathname) return file()
  })
}

it('字体信息失败进入近似模式，重新挂载可重试并释放渲染实例', async () => {
  mockFetch((request) =>
    new URL(request.url).pathname === API.subtitleFont
      ? new Response('', { status: 503 })
      : undefined,
  )
  const failed = render()
  await waitFor(() => expect(failed.onMode).toHaveBeenLastCalledWith('fallback'))
  expect(doubles.instances).toHaveLength(0)
  failed.unmount()
  fonts()
  const fresh = render()
  await waitFor(() => expect(fresh.onMode).toHaveBeenLastCalledWith('libass'))
  const sub = doubles.instances[0]!
  expect(sub.renderer.addFonts).toHaveBeenCalledExactlyOnceWith([new Uint8Array([1, 2, 3])])
  fresh.unmount()
  expect(sub.destroy).toHaveBeenCalledOnce()
})

it('字体文件失败不创建渲染器，重试可恢复', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fonts(() => new Response('', { status: 503 }))
  const f = render()
  await waitFor(() => expect(f.onMode).toHaveBeenLastCalledWith('fallback'))
  expect(doubles.instances).toHaveLength(0)
  f.unmount()
  fonts()
  const next = render()
  await waitFor(() => expect(next.onMode).toHaveBeenLastCalledWith('libass'))
})

it('字体等待中关闭会取消读取，迟到成功不创建渲染器', async () => {
  let release!: (response: Response) => void
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  let requested = false
  fonts(() => {
    requested = true
    return gate
  })
  const f = render()
  await waitFor(() => expect(requested).toBe(true))
  f.unmount()
  await act(async () => {
    release(new Response(new Uint8Array([1])))
    await gate
  })
  expect(doubles.instances).toHaveLength(0)
  expect(f.onMode).not.toHaveBeenCalledWith('libass')
})

it('暂停时字幕内容改变仍立即重绘，失败时释放实例且不再响应播放头', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fonts()
  const f = render()
  await waitFor(() => expect(f.onMode).toHaveBeenLastCalledWith('libass'))
  const sub = doubles.instances[0]!
  await waitFor(() => expect(sub.renderer.setTrack).toHaveBeenLastCalledWith('字幕一'))
  f.rerender(<SubtitleLayer {...f.props} build={() => '已校订字幕'} />)
  await waitFor(() => expect(sub.renderer.setTrack).toHaveBeenLastCalledWith('已校订字幕'))
  expect(sub.manualRender).toHaveBeenCalledWith(expect.objectContaining({ mediaTime: 0 }), true)
  sub.manualRender.mockRejectedValueOnce(new Error('worker failed'))
  act(() => head.seek(2))
  await waitFor(() => expect(f.onMode).toHaveBeenLastCalledWith('fallback'))
  expect(sub.destroy).toHaveBeenCalledOnce()
  const count = sub.manualRender.mock.calls.length
  act(() => head.seek(3))
  expect(sub.manualRender).toHaveBeenCalledTimes(count)
})
