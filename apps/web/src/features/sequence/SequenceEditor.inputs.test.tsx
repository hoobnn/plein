// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { fireEvent, renderApp, screen } from '../../testing/render'
import { Modal } from '../../ui/Modal'
import { TextCell } from '../storyboard/StoryboardCells'
import { NumberField, RequiredSecondsField, SubtitleField } from './SequenceEditor'

for (const mode of ['native', 'legacy'] as const) {
  const composing = mode === 'native' ? { isComposing: true } : { keyCode: 229 }
  it(`分镜中文草稿在 ${mode} Escape 后保留，失焦才写入`, async () => {
    const change = vi.fn(),
      close = vi.fn()
    const { user } = renderApp(
      <Modal label="分镜表" onClose={close} isolateKeys>
        <TextCell value="原始画面" readValue={() => '原始画面'} label="画面" onChange={change} />
        <button type="button">下一个字段</button>
      </Modal>,
    )
    const input = screen.getByRole('textbox', { name: '画面' })
    await user.clear(input)
    await user.type(input, '正在编辑的中文草稿')
    expect(fireEvent.keyDown(input, { key: 'Escape', ...composing })).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(change).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    await user.tab()
    expect(change).toHaveBeenCalledExactlyOnceWith('正在编辑的中文草稿')
  })
  it(`字幕和秒数 ${mode} Enter 不提前失焦或提交`, async () => {
    const subtitle = vi.fn(),
      seconds = vi.fn()
    const { user } = renderApp(
      <>
        <SubtitleField value="" readValue={() => ''} placeholder="字幕" onChange={subtitle} />
        <NumberField label="秒数" value={3} readValue={() => 3} onChange={seconds} />
      </>,
    )
    for (const [input, value, change, expected] of [
      [screen.getByRole('textbox'), '还在组词的字幕', subtitle, '还在组词的字幕'],
      [screen.getByRole('spinbutton'), '2.5', seconds, 2.5],
    ] as const) {
      await user.clear(input)
      await user.type(input, value)
      expect(fireEvent.keyDown(input, { key: 'Enter', ...composing })).toBe(true)
      expect(document.activeElement).toBe(input)
      expect(change).not.toHaveBeenCalled()
      await user.keyboard('{Enter}')
      expect(change).toHaveBeenCalledExactlyOnceWith(expected)
    }
  })
  for (const key of ['Enter', 'Escape']) {
    it(`样片必填秒数 ${mode} ${key} 保留草稿，确认后提交`, async () => {
      const change = vi.fn()
      const { user } = renderApp(
        <RequiredSecondsField
          label="样片镜头时长（秒）"
          value={3}
          min={1}
          max={30}
          onChange={change}
        />,
      )
      const input = screen.getByRole('spinbutton') as HTMLInputElement
      await user.clear(input)
      await user.type(input, '2.5')
      expect(fireEvent.keyDown(input, { key, ...composing })).toBe(true)
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('2.5')
      expect(change).not.toHaveBeenCalled()
      await user.keyboard('{Enter}')
      expect(change).toHaveBeenCalledExactlyOnceWith(2.5)
    })
  }
}
