// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import { ModePicker } from './ModePicker'

it('仅尾帧可显式选择并说明用途，不支持的模型不能选择', async () => {
  const change = vi.fn()
  const view = renderApp(<ModePicker value="text" images={1} onChange={change} />)
  await view.user.click(screen.getByRole('button', { name: '生成模式' }))
  const last = screen.getByRole('option', { name: /仅尾帧/ })
  expect(last.textContent).toContain('连入 1 张图作尾帧')
  await view.user.click(last)
  expect(change).toHaveBeenCalledWith('lastFrame')
  view.rerender(
    <ModePicker
      value="reference"
      images={1}
      videos={1}
      audios={1}
      allowedModes={['text', 'image', 'frames', 'reference']}
      onChange={change}
    />,
  )
  await view.user.click(screen.getByRole('button', { name: '生成模式' }))
  expect((screen.getByRole('option', { name: /仅尾帧/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('option', { name: /多模态参考/ }).textContent).toContain(
    '1 张图、1 段视频、1 段音频',
  )
})
