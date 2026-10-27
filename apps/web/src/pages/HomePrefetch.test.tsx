// @vitest-environment happy-dom
import type { Project } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../testing/fetch'
import { fireEvent, renderApp, screen } from '../testing/render'
import { preloadEditor } from './EditorLoader'
import { Home } from './Home'

vi.mock('./EditorLoader', () => ({ preloadEditor: vi.fn() }))

it.each(['pointerEnter', 'pointerDown', 'focus'] as const)(
  '首页不主动预取，项目卡 %s 才加载工作区',
  async (event) => {
    localStorage.setItem('plein.welcome', '1')
    const project: Project = {
      id: 'p',
      title: '项目初稿',
      createdAt: 1,
      updatedAt: 1,
      canvases: 1,
      lastCanvasId: 'c',
    }
    mockFetch((request) =>
      new URL(request.url).pathname === '/api/projects' ? Response.json([project]) : undefined,
    )
    vi.mocked(preloadEditor).mockClear()
    renderApp(<Home onOpenSettings={() => {}} />)
    const title = await screen.findByRole('link', { name: '项目初稿' })
    expect(preloadEditor).not.toHaveBeenCalled()
    fireEvent[event](title)
    expect(preloadEditor).toHaveBeenCalledTimes(1)
    expect(location.hash).toBe('#/')
  },
)
