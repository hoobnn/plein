// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { EditorPanels } from './EditorPanels'

const imports = vi.hoisted(() => {
  const pending = () => {
    let resolve!: () => void
    let loaded!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    const settled = new Promise<void>((done) => {
      loaded = done
    })
    return { promise, resolve, loaded, settled, calls: 0 }
  }
  return { sequence: pending(), storyboard: pending(), workbench: pending() }
})
vi.mock('../features/sequence/SequenceEditor', async (original) => {
  imports.sequence.calls++
  await imports.sequence.promise
  const module = await original()
  imports.sequence.loaded()
  return module
})
vi.mock('../features/storyboard/StoryboardEditor', async (original) => {
  imports.storyboard.calls++
  await imports.storyboard.promise
  const module = await original()
  imports.storyboard.loaded()
  return module
})
vi.mock('../features/storyboard/ShotWorkbench', async (original) => {
  imports.workbench.calls++
  await imports.workbench.promise
  const module = await original()
  imports.workbench.loaded()
  return module
})

it.each([
  {
    name: '序列',
    pending: imports.sequence,
    activate: () => useCanvas.getState().openSequence('sequence-one'),
    close: () => useCanvas.getState().openSequence(null),
  },
  {
    name: '分镜表',
    pending: imports.storyboard,
    activate: () => useCanvas.getState().openStoryboard('board-one'),
    close: () => useCanvas.getState().openStoryboard(null),
  },
  {
    name: '镜头工作台',
    pending: imports.workbench,
    activate: () => useCanvas.getState().openShotWorkbench({ boardId: 'board-one', shotId: 'one' }),
    close: () => useCanvas.getState().openShotWorkbench(null),
  },
])('$name 首次按需加载有反馈，等待中关闭会立即收起，重开复用模块', async (panel) => {
  renderApp(<EditorPanels />, { dialogs: false })
  expect(screen.queryByRole('status')).toBeNull()
  expect(panel.pending.calls).toBe(0)
  act(panel.activate)
  await waitFor(() => expect(panel.pending.calls).toBe(1))
  expect(screen.getByRole('status').textContent).toBe(`正在打开${panel.name}…`)
  expect(screen.queryByRole('dialog')).toBeNull()
  act(panel.close)
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => {
    panel.pending.resolve()
    await panel.pending.settled
  })
  expect(screen.queryByRole('status')).toBeNull()
  act(panel.activate)
  expect(screen.queryByRole('status')).toBeNull()
  expect(panel.pending.calls).toBe(1)
})
