// @vitest-environment happy-dom
import type { Project } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { cacheProject, queryClient, queryKeys } from '../api/query'
import { useRoute } from '../router'
import { useCanvas } from '../stores/canvas'
import { useSidebar } from '../stores/sidebar'
import { useTheme } from '../stores/theme'
import { ThemeToggle } from '../ui/ThemeToggle'
import { mockMatchMedia, mockResizeObserver } from './browser'
import { mockFetch } from './fetch'
import { act, renderApp, resetStoreAfterEach, screen } from './render'

resetStoreAfterEach(useSidebar)
const originalResizeObserver = ResizeObserver

function ProjectName() {
  const query = useQuery({
    queryKey: queryKeys.project('project-1'),
    queryFn: () => api.project('project-1'),
  })
  const route = useRoute()
  return (
    <p>
      {route.name}：{query.data?.title ?? '加载中'}
    </p>
  )
}

// 这组有意跨用例留状态，验证共享入口的清理，而不是让业务测试依赖顺序。
describe('组件隔离与真实查询缓存', { concurrent: false }, () => {
  it('API 读取与命令式更新使用同一份缓存', async () => {
    const project: Project = {
      id: 'project-1',
      title: '原项目',
      createdAt: 1,
      updatedAt: 1,
      canvases: 0,
      lastCanvasId: null,
    }
    mockFetch(() => Response.json(project))
    const { queryClient: client } = renderApp(<ProjectName />, {
      route: { name: 'canvas', id: 'canvas-1' },
    })
    expect(client).toBe(queryClient)
    await screen.findByText('canvas：原项目')
    act(() => cacheProject({ ...project, title: '确认后的名称' }))
    await screen.findByText('canvas：确认后的名称')
    act(() => {
      useCanvas.setState({ canvasId: 'canvas-1' })
      useSidebar.getState().toggle(false)
      useTheme.getState().setPref('light')
    })
    localStorage.setItem('testing', '残留')
    sessionStorage.setItem('testing', '残留')
    vi.spyOn(api, 'project')
    vi.stubGlobal('ResizeObserver', class {})
  })

  it('下一条用例没有前一条的 DOM、路由、缓存、store、storage 或 spy', () => {
    expect(document.body.childElementCount).toBe(0)
    expect(location.hash).toBe('#/')
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(useCanvas.getState().canvasId).toBeNull()
    expect(useSidebar.getState().open).toBe(useSidebar.getInitialState().open)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(vi.isMockFunction(api.project)).toBe(false)
    expect(ResizeObserver).toBe(originalResizeObserver)
    expect(useTheme.getState().pref).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})

function Measurements() {
  const element = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const media = matchMedia('(max-width: 600px)')
    const change = () => setNarrow(media.matches)
    media.addEventListener('change', change)
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(element.current!)
    return () => {
      media.removeEventListener('change', change)
      observer.disconnect()
    }
  }, [])
  return (
    <div ref={element}>
      {narrow ? '窄' : '宽'}：{width}
    </div>
  )
}

it('媒体与尺寸替身驱动组件订阅，卸载后不再接收变化', () => {
  const media = mockMatchMedia()
  const observer = mockResizeObserver()
  const { unmount } = renderApp(<Measurements />)
  const element = screen.getByText('宽：0')
  act(() => {
    media.set('(max-width: 600px)', true)
    observer.resize(element, 360, 200)
  })
  expect(screen.getByText('窄：360')).toBe(element)
  unmount()
  act(() => {
    media.set('(max-width: 600px)', false)
    observer.resize(element, 900, 200)
  })
  expect(element.textContent).toBe('窄：360')
})

it('模块加载时建立的系统主题订阅仍接收测试中的媒体变化', async () => {
  const media = mockMatchMedia()
  const { user } = renderApp(<ThemeToggle />)
  act(() => media.set('(prefers-color-scheme: light)', true))
  expect(useTheme.getState().name).toBe('light')
  expect(document.documentElement.dataset.theme).toBe('light')
  await user.click(screen.getByRole('button', { name: '深色' }))
  act(() => media.set('(prefers-color-scheme: light)', false))
  act(() => media.set('(prefers-color-scheme: light)', true))
  expect(document.documentElement.dataset.theme).toBe('dark')
  await user.click(screen.getByRole('button', { name: '跟随系统' }))
  expect(document.documentElement.dataset.theme).toBe('light')
})

function DebouncedInput() {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSaved(text), 250)
    return () => clearTimeout(timer)
  }, [text])
  return (
    <>
      <input aria-label="草稿" value={text} onChange={(event) => setText(event.target.value)} />
      <p>已保存：{saved}</p>
    </>
  )
}

it('假计时器下 user-event 可输入，并由用例控制防抖完成', async () => {
  vi.useFakeTimers()
  const { user } = renderApp(<DebouncedInput />)
  await user.type(screen.getByRole('textbox', { name: '草稿' }), '新的草稿')
  expect(screen.getByText('已保存：')).toBeTruthy()
  await act(() => vi.advanceTimersByTimeAsync(250))
  expect(screen.getByText('已保存：新的草稿')).toBeTruthy()
})
