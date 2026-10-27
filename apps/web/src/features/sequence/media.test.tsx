// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { mockFetch } from '../../testing/fetch'
import { Filmstrip, MediaReloadContext, Waveform } from './media'

it('波形失败可见，重新加载恢复同一裁切范围，成功后不重复请求', async () => {
  let failed = true
  const fetch = mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/peaks')
      ? failed
        ? new Response(null, { status: 503 })
        : Response.json({ rate: 100, peaks: Array(500).fill(0.5) })
      : undefined,
  )
  const view = (reload: number) => (
    <MediaReloadContext.Provider value={reload}>
      <Waveform assetId="retry-peaks" from={1} to={3} width={300} />
    </MediaReloadContext.Provider>
  )
  const { container, rerender } = renderApp(view(0))
  await screen.findByText('波形加载失败')
  failed = false
  rerender(view(1))
  await waitFor(() => expect(container.querySelector('path')).not.toBeNull())
  expect(screen.queryByText('波形加载失败')).toBeNull()
  const path = container.querySelector('path')!.getAttribute('d')
  await act(async () => rerender(view(2)))
  expect(container.querySelector('path')!.getAttribute('d')).toBe(path)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('三十分钟峰值可直接绘制和缩放，最多1200根柱且不展开整个数组', async () => {
  mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/peaks')
      ? Response.json({ rate: 100, peaks: Array(180_000).fill(0.5) })
      : undefined,
  )
  const { container, rerender } = renderApp(
    <Waveform assetId="long-peaks" from={0} to={1800} width={300} />,
  )
  await waitFor(() => expect(container.querySelector('path')).not.toBeNull())
  const before = container.querySelector('path')!.getAttribute('d')!
  rerender(<Waveform assetId="long-peaks" from={0} to={1800} width={30_000} />)
  const after = container.querySelector('path')!.getAttribute('d')!
  expect(after).not.toBe(before)
  expect(after.match(/M/g)).toHaveLength(1200)
  expect(after).not.toMatch(/NaN|Infinity/)
})

it('缩略图失败可重试，换素材后迟到回调不能覆盖新结果', async () => {
  const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null; src: string }> =
    []
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      src = ''
      constructor() {
        images.push(this)
      }
    },
  )
  const view = (assetId: string, reload = 0) => (
    <MediaReloadContext.Provider value={reload}>
      <Filmstrip
        assetId={assetId}
        duration={3}
        aspect={1.5}
        from={0.5}
        to={2}
        width={300}
        height={40}
      />
    </MediaReloadContext.Provider>
  )
  const { container, rerender } = renderApp(view('one'))
  act(() => images[0]!.onerror?.())
  expect(screen.getByText('缩略图加载失败')).toBeTruthy()
  rerender(view('one', 1))
  expect(images[0]!.onerror).toBeNull()
  const late = images[1]!.onload!
  rerender(view('two', 1))
  act(late)
  expect(container.querySelector('.seq-filmstrip')).toBeNull()
  act(() => images[2]!.onload?.())
  expect(container.querySelectorAll('.seq-filmstrip > span')).toHaveLength(5)
  expect(container.querySelector('span')!.style.backgroundImage).toContain('/two/filmstrip')
  expect(screen.queryByText('缩略图加载失败')).toBeNull()
})
