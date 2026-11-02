// @vitest-environment happy-dom
import '../styles.css'
import { m } from 'motion/react'
import { useState } from 'react'
import * as LazyMotionModule from './LazyMotion'
import { expect, it, vi } from 'vite-plus/test'
import { renderApp, screen, waitFor } from '../testing/render'
import { AnimatePresence, fadeVariants, useOverlayMotion } from './motion'

function Fixture() {
  const [clicked, setClicked] = useState(false)
  return (
    <AnimatePresence>
      <m.div {...useOverlayMotion(fadeVariants)}>
        <button type="button" onClick={() => setClicked(true)}>
          {clicked ? '已点击' : '可用按钮'}
        </button>
      </m.div>
    </AnimatePresence>
  )
}

it('特性加载失败时浮层可见且仍可操作', async () => {
  vi.spyOn(LazyMotionModule, 'loadMotionFeatures').mockRejectedValue(new Error('加载失败'))
  const { user } = renderApp(<Fixture />, { dialogs: false })
  const button = await screen.findByRole('button', { name: '可用按钮' })
  await waitFor(() => expect(getComputedStyle(button.parentElement!).opacity).toBe('1'))
  await user.click(button)
  expect(screen.getByRole('button', { name: '已点击' })).toBeTruthy()
})
