// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { renderApp, screen, waitFor } from '../testing/render'
import { Modal } from './Modal'

function content() {
  return <p>内容</p>
}

it('打开处漏了 Motion 宿主时浮层降级为可见，并在开发期报错', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    renderApp(
      <Modal label="缺宿主" onClose={() => {}}>
        {content()}
      </Modal>,
      { deferredMotion: true, dialogs: false },
    )
    const dialog = await screen.findByRole('dialog', { name: '缺宿主' })
    expect(dialog.hasAttribute('data-motion-host-missing')).toBe(true)
    await waitFor(() => expect(Number(getComputedStyle(dialog).opacity)).toBe(1))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('缺少 Motion 宿主'))
  } finally {
    error.mockRestore()
  }
})

it('打开处有宿主时不报缺失，仍走正常进场', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    renderApp(
      <Modal label="有宿主" onClose={() => {}}>
        {content()}
      </Modal>,
      { dialogs: false },
    )
    const dialog = await screen.findByRole('dialog', { name: '有宿主' })
    expect(dialog.hasAttribute('data-motion-host-missing')).toBe(false)
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('缺少 Motion 宿主'))
  } finally {
    error.mockRestore()
  }
})
