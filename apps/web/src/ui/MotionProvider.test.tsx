// @vitest-environment happy-dom
import { MotionConfig } from 'motion/react'
import { lazy, useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { renderApp, screen, waitFor } from '../testing/render'
import { DeferredPanel } from './DeferredPanel'

const DeferredToast = lazy(() =>
  import('../pages/HomeToast').then((module) => ({ default: module.HomeToast })),
)

function Fixture() {
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <MotionConfig reducedMotion="never">
      <button type="button" onClick={() => setNotice((current) => (current ? null : '已保存'))}>
        切换提示
      </button>
      <DeferredPanel active={!!notice}>
        <DeferredToast notice={notice} />
      </DeferredPanel>
    </MotionConfig>
  )
}

it('LazyMotion 与浮层延后加载时保留打开请求并正常进退场', async () => {
  const { user } = renderApp(<Fixture />, { deferredMotion: true })
  const toggle = screen.getByRole('button', { name: '切换提示' })
  await user.click(toggle)
  expect((await screen.findByRole('status')).textContent).toBe('已保存')
  await user.click(toggle)
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
})
