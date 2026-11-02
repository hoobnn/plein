// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnimatePresence, m } from 'motion/react'
import { expect, it } from 'vite-plus/test'
import { renderApp, screen, waitFor } from '../testing/render'
import { fadeVariants, useOverlayMotion } from './motion'

function Overlay({ open }: { open: boolean }) {
  return (
    <AnimatePresence>
      {open && <m.div data-testid="overlay" {...useOverlayMotion(fadeVariants)} />}
    </AnimatePresence>
  )
}

it('减少动态效果时零时长退场并卸载', async () => {
  const { rerender } = renderApp(<Overlay open />, { dialogs: false })
  await screen.findByTestId('overlay')
  rerender(<Overlay open={false} />)
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
