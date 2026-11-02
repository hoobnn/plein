// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { m, MotionConfig } from 'motion/react'
import { expect, it } from 'vite-plus/test'
import { mockMatchMedia } from '../testing/browser'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { AnimatePresence, fadeVariants, useOverlayMotion } from './motion'

function OverlayContent() {
  return <m.div data-testid="overlay" {...useOverlayMotion(fadeVariants)} />
}

function Overlay({ open }: { open: boolean }) {
  return <AnimatePresence>{open && <OverlayContent />}</AnimatePresence>
}

it('减少动态效果时零时长退场并卸载', async () => {
  const { rerender } = renderApp(<Overlay open />, { dialogs: false })
  await screen.findByTestId('overlay')
  rerender(<Overlay open={false} />)
  expect(screen.queryByTestId('overlay')).toBeNull()
})

it('运行中开启减少动态效果后关闭会同步卸载', async () => {
  const media = mockMatchMedia(() => false)
  const { rerender } = renderApp(<Overlay open />, { dialogs: false })
  await screen.findByTestId('overlay')
  act(() => media.set('(prefers-reduced-motion: reduce)', true))
  rerender(<Overlay open={false} />)
  expect(screen.queryByTestId('overlay')).toBeNull()
})

it('正常动态效果保留退场并用关闭态屏蔽指针', async () => {
  const { rerender } = renderApp(
    <MotionConfig reducedMotion="never">
      <Overlay open />
    </MotionConfig>,
    { dialogs: false },
  )
  await screen.findByTestId('overlay')
  rerender(
    <MotionConfig reducedMotion="never">
      <Overlay open={false} />
    </MotionConfig>,
  )
  const overlay = screen.getByTestId('overlay')
  expect(overlay.dataset.pleinExiting).toBe('')
  await waitFor(() => expect(screen.queryByTestId('overlay')).toBeNull())
})

it('LazyMotion strict 下禁止直接使用 motion 组件', () => {
  const root = join(import.meta.dirname, '..')
  const pending = [root]
  const files: string[] = []
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  const offenders = files.filter((file) => {
    const source = readFileSync(file, 'utf8')
    return /<motion\./.test(source) || /\bmotion\.create\s*\(/.test(source)
  })
  expect(offenders).toEqual([])
})
