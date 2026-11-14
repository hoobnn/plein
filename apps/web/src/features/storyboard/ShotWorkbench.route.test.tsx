// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, type PleinDoc } from '@plein/doc'
import { Shot } from '@plein/nodes'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { navigate, useRoute } from '../../router'
import { useLeaveGuard } from '../../shell/useLeaveGuard'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { useSession } from '../../stores/session'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { ShotWorkbench } from './ShotWorkbench'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})

function fixture() {
  const doc = createDoc()
  docs.push(doc)
  const shots = ['one', 'two'].map((id, index) =>
    Shot.parse({
      id,
      no: index + 1,
      duration: 3,
      description: `镜头 ${index + 1} 原始描述`,
      imagePrompt: '原始首帧',
      motionPrompt: `镜头 ${index + 1} 原始运动`,
      lighting: '原始光影',
    }),
  )
  const board = createElement(doc, {
    x: 0,
    y: 0,
    w: 100,
    h: 80,
    id: 'board',
    kind: 'node',
    nodeType: 'plein/storyboard',
    params: { shots },
  })
  const engine = {
    doc,
    selection: { set: vi.fn(), values: vi.fn(() => []) },
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({
    engine,
    canvasId: 'canvas',
    shotWorkbench: { boardId: board, shotId: 'one' },
    localEdits: false,
  })
  useSession.setState({ info: { principal: { id: 'local', role: 'owner' } } as never })
  useCatalog.setState({ catalog: null })
  return { doc, board }
}

/** 沿 Editor.tsx 的实际接线：路由在画布时挂载工作台，文档 dirty 时安装原有 guard。 */
function Shell() {
  const route = useRoute()
  const localEdits = useCanvas((s) => s.localEdits)
  useLeaveGuard(route.name === 'canvas' && localEdits, '草稿画布')
  return route.name === 'canvas' ? <ShotWorkbench /> : <p data-testid="home">首页</p>
}

const field = () => screen.getByRole('textbox', { name: '工作台画面描述' })

function quotaOnWorkbenchDrafts() {
  const original = localStorage.setItem.bind(localStorage)
  return vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (String(key).startsWith('plein:workbench-draft:'))
      throw new DOMException('quota', 'QuotaExceededError')
    return original(key, value)
  })
}

it('正常落盘的工作台草稿不拦 SPA 离开', async () => {
  fixture()
  const { user } = renderApp(<Shell />, { route: { name: 'canvas', id: 'canvas' } })
  await user.clear(field())
  await user.type(field(), '已经写进本机的草稿')
  expect(screen.queryByText(/暂未存到本机/)).toBeNull()
  await act(async () => navigate({ name: 'home' }))
  await waitFor(() => expect(screen.getByTestId('home')).toBeTruthy())
  expect(location.hash).toBe('#/')
  expect(screen.queryByRole('dialog', { name: '镜头草稿还没有保存' })).toBeNull()
})

it('本机写不进时 navigate 与浏览器 hash 返回都先确认，留在工作台保持内容和地址', async () => {
  fixture()
  const setItem = quotaOnWorkbenchDrafts()
  try {
    const { user } = renderApp(<Shell />, { route: { name: 'canvas', id: 'canvas' } })
    await user.clear(field())
    await user.type(field(), '写不进本机的草稿')
    await waitFor(() => expect(screen.getByText(/暂未存到本机/)).toBeTruthy())

    await act(async () => navigate({ name: 'home' }))
    expect(await screen.findByRole('dialog', { name: '镜头草稿还没有保存' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '留在工作台' }))
    expect(location.hash).toBe('#/c/canvas')
    expect(screen.queryByTestId('home')).toBeNull()
    expect((field() as HTMLTextAreaElement).value).toBe('写不进本机的草稿')

    await act(async () => {
      location.hash = '#/'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByRole('dialog', { name: '镜头草稿还没有保存' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '留在工作台' }))
    expect(location.hash).toBe('#/c/canvas')
    expect((field() as HTMLTextAreaElement).value).toBe('写不进本机的草稿')

    await act(async () => navigate({ name: 'home' }))
    await user.click(await screen.findByRole('button', { name: '丢弃草稿并离开' }))
    await waitFor(() => expect(screen.getByTestId('home')).toBeTruthy())
    expect(location.hash).toBe('#/')
    expect(screen.queryByRole('dialog', { name: '镜头工作台' })).toBeNull()
    expect(localStorage.getItem('plein:workbench-draft:v1:canvas:board')).toBeNull()
  } finally {
    setItem.mockRestore()
  }
})

it('文档 dirty guard 与草稿 guard 共存，任一取消都留在原画布；force 可退出', async () => {
  fixture()
  useCanvas.setState({ localEdits: true })
  const setItem = quotaOnWorkbenchDrafts()
  try {
    const { user } = renderApp(<Shell />, { route: { name: 'canvas', id: 'canvas' } })
    await user.clear(field())
    await user.type(field(), '写不进本机的草稿')
    await waitFor(() => expect(screen.getByText(/暂未存到本机/)).toBeTruthy())

    await act(async () => navigate({ name: 'home' }))
    expect(await screen.findByRole('dialog', { name: '还有改动没有保存' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '丢弃改动并离开' }))
    expect(await screen.findByRole('dialog', { name: '镜头草稿还没有保存' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '留在工作台' }))
    expect(location.hash).toBe('#/c/canvas')
    expect((field() as HTMLTextAreaElement).value).toBe('写不进本机的草稿')

    await act(async () => navigate({ name: 'home' }, { force: true }))
    await waitFor(() => expect(screen.getByTestId('home')).toBeTruthy())
    expect(location.hash).toBe('#/')
  } finally {
    setItem.mockRestore()
  }
})
