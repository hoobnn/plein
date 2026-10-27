// @vitest-environment happy-dom
import { sequenceNode } from '@plein/nodes'
import { expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen } from '../../testing/render'
import { Presence } from '../../ui/Presence'
import { SequencePreview } from './SequencePreview'
import { Playhead } from './playhead'

const engines = vi.hoisted(
  () =>
    [] as Array<{
      issues: (count: number) => void
      retryFailed: ReturnType<typeof vi.fn>
      dispose: ReturnType<typeof vi.fn>
    }>,
)
vi.mock('./engine', async (original) => ({
  ...(await original<typeof import('./engine')>()),
  PreviewEngine: class {
    retryFailed = vi.fn(() => this.issues(0))
    dispose = vi.fn()
    constructor(
      _playhead: unknown,
      public issues: (count: number) => void,
    ) {
      engines.push(this)
    }
    attach() {}
    setScene() {}
  },
}))

it('读取失败提供恢复入口，重试保留播放位置，关闭时立即暂停并释放引擎', async () => {
  const playhead = new Playhead()
  playhead.setTotal(2)
  playhead.seek(0.7)
  const preview = (
    <SequencePreview
      rows={[]}
      timeline={{ total: 2, clips: [] }}
      params={sequenceNode.params.parse({ subtitles: false })}
      playhead={playhead}
    />
  )
  const { user, rerender } = renderApp(<Presence>{preview}</Presence>)
  const engine = engines.at(-1)!
  act(() => engine.issues(2))
  expect(screen.getByRole('alert').textContent).toContain('预览素材读取失败')
  await user.click(screen.getByRole('button', { name: '重试失败素材' }))
  expect(engine.retryFailed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(playhead.t).toBe(0.7)
  await user.click(screen.getByRole('button', { name: '播放' }))
  expect(playhead.playing).toBe(true)
  rerender(<Presence>{null}</Presence>)
  expect(playhead.playing).toBe(false)
  expect(engine.dispose).toHaveBeenCalledOnce()
})
