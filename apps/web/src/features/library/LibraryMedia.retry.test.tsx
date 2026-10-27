// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vite-plus/test'
import { fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { LibraryThumbnail, ReferenceThumbnail, ReferenceVideo } from './LibraryMedia'

describe('素材预览失败后的恢复', () => {
  it('缩略图加载失败后仍可选用，并说明失败不等于素材不可用', async () => {
    const onSelect = vi.fn()
    renderApp(
      <LibraryThumbnail
        src="/reference.png"
        label="选择图片「水杯」"
        title="水杯.png"
        onSelect={onSelect}
      />,
    )
    const image = document.querySelector('img')!
    fireEvent.error(image)

    await waitFor(() =>
      expect(screen.getByRole('img', { name: '选择图片「水杯」加载失败' })).toBeTruthy(),
    )
    const button = screen.getByRole('button', { name: '选择图片「水杯」' })
    // 失败只是缩略图没渲染出来，素材本身还能选。
    expect(button.getAttribute('title')).toContain('加载失败，仍可选用')
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('缩略图重试后焦点回到缩略图按钮，选中状态不变', async () => {
    const onSelect = vi.fn()
    renderApp(
      <LibraryThumbnail
        src="/reference.png"
        label="选择图片「水杯」"
        selected
        onSelect={onSelect}
      />,
    )
    fireEvent.error(document.querySelector('img')!)
    const retry = await screen.findByRole('button', { name: '重新加载选择图片「水杯」' })
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const button = screen.getByRole('button', { name: '选择图片「水杯」' })
    // 已选中的缩略图本身不可再点，焦点落回它所在的分组，不丢出这个格子。
    expect(document.activeElement).toBe(button.closest('[role="group"]'))
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('未选中的缩略图重试后焦点回到缩略图按钮', async () => {
    renderApp(
      <LibraryThumbnail src="/reference.png" label="选择图片「水杯」" onSelect={() => {}} />,
    )
    fireEvent.error(document.querySelector('img')!)
    const retry = await screen.findByRole('button', { name: '重新加载选择图片「水杯」' })
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '选择图片「水杯」' }))
  })

  it('参考条缩略图重试后焦点回到缩略图，预览与固定互不影响', async () => {
    const onPreview = vi.fn()
    const onSelect = vi.fn()
    renderApp(
      <ReferenceThumbnail
        src="/reference.png"
        label="参考图 1"
        selected={false}
        onPreview={onPreview}
        onSelect={onSelect}
      />,
    )
    fireEvent.error(document.querySelector('img')!)
    const retry = await screen.findByRole('button', { name: '重新加载参考图 1' })
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
    const thumb = screen.getByRole('button', { name: '参考图 1' })
    expect(document.activeElement).toBe(thumb)
    expect(thumb.getAttribute('aria-pressed')).toBe('false')
    expect(onSelect).not.toHaveBeenCalled()
    expect(onPreview).not.toHaveBeenCalled()
  })

  it('参考视频失败给出重载入口，重试后焦点回到播放控件', async () => {
    renderApp(<ReferenceVideo src="/reference.mp4" />)
    const video = document.querySelector('video')!
    fireEvent.error(video)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('视频加载失败')
    const retry = screen.getByRole('button', { name: '重新加载参考视频' })
    retry.focus()
    fireEvent.click(retry)

    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())
    expect(document.activeElement).toBe(document.querySelector('video'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('参考视频重试仍失败时还能再试，不会把焦点丢给别处', async () => {
    renderApp(<ReferenceVideo src="/reference.mp4" />)
    fireEvent.error(document.querySelector('video')!)
    const retry = await screen.findByRole('button', { name: '重新加载参考视频' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(document.querySelector('video')).toBeTruthy())

    // 第二次又失败：重载入口必须还在，用户可以继续试。
    fireEvent.error(document.querySelector('video')!)
    const again = await screen.findByRole('button', { name: '重新加载参考视频' })
    expect(again).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('视频加载失败')
  })
})
