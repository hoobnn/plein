// @vitest-environment happy-dom
import { type ComponentType, useEffect, useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { DeferredPanel } from './DeferredPanel'
import { StaticToast } from './StaticToast'

function Loaded() {
  return <p>浮层已加载</p>
}

function RetryFixture({ load }: { load: () => Promise<ComponentType> }) {
  const [active, setActive] = useState(false)
  return (
    <>
      <h1>主界面仍可用</h1>
      <button type="button" onClick={() => setActive((current) => !current)}>
        切换浮层
      </button>
      <DeferredPanel
        active={active}
        load={load}
        props={{}}
        fallback={<StaticToast>重要提示</StaticToast>}
      />
    </>
  )
}

it('导入失败不进入全局错误页，可点击重试恢复并再次打开', async () => {
  const load = vi
    .fn<() => Promise<ComponentType>>()
    .mockRejectedValueOnce(new Error('模块连接中断'))
    .mockResolvedValue(Loaded)
  const { user } = renderApp(<RetryFixture load={load} />)
  await user.click(screen.getByRole('button', { name: '切换浮层' }))
  expect((await screen.findByRole('status')).textContent).toBe('重要提示')
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('heading', { name: '主界面仍可用' })).toBeTruthy()
  await user.click(await screen.findByRole('button', { name: '重试' }))
  expect(await screen.findByText('浮层已加载')).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(2)
  await user.click(screen.getByRole('button', { name: '切换浮层' }))
  await user.click(screen.getByRole('button', { name: '切换浮层' }))
  expect(await screen.findByText('浮层已加载')).toBeTruthy()
})

function SlowNotice() {
  const notice = useCanvas((state) => state.notice)
  useEffect(() => {
    useCanvas.getState().notify('慢加载也显示满四秒')
  }, [])
  return (
    <DeferredPanel
      active={!!notice}
      load={() => new Promise<ComponentType>(() => {})}
      props={{}}
      fallback={notice ? <StaticToast>{notice}</StaticToast> : null}
    />
  )
}

it('模块加载慢于清除期限时轻量提示仍显示满时长', () => {
  vi.useFakeTimers()
  renderApp(<SlowNotice />)
  expect(screen.getByRole('status').textContent).toBe('慢加载也显示满四秒')
  act(() => {
    void vi.advanceTimersByTime(3999)
  })
  expect(screen.getByRole('status').textContent).toBe('慢加载也显示满四秒')
  act(() => {
    void vi.advanceTimersByTime(1)
  })
  expect(screen.queryByRole('status')).toBeNull()
})

function NamedFixture({ load }: { load: () => Promise<ComponentType> }) {
  const [active, setActive] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setActive(true)}>
        打开设置
      </button>
      <DeferredPanel
        active={active}
        load={load}
        props={{}}
        panel={{ name: '设置', onClose: () => setActive(false) }}
      />
    </>
  )
}

it('取消正在打开的面板后，再次打开不会被上一次迟到的结果接管', async () => {
  const pending: Array<(component: ComponentType) => void> = []
  const load = () => new Promise<ComponentType>((resolve) => pending.push(resolve))
  const { user } = renderApp(<NamedFixture load={load} />)
  const open = screen.getByRole('button', { name: '打开设置' })
  await user.click(open)
  expect(screen.getByRole('status').textContent).toBe('正在打开设置…')
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(document.querySelector('[data-plein-pending-panel]')).toBeNull()
  await user.click(open)
  await act(async () => pending[0]!(Loaded))
  expect(screen.getByRole('status').textContent).toBe('正在打开设置…')
  expect(screen.queryByText('浮层已加载')).toBeNull()
  await user.keyboard('{Escape}')
  await act(async () => pending[1]!(Loaded))
  expect(document.querySelector('[data-plein-pending-panel]')).toBeNull()
  expect(screen.queryByText('浮层已加载')).toBeNull()
  await user.click(open)
  expect(screen.getByText('浮层已加载')).toBeTruthy()
  expect(pending).toHaveLength(2)
})

it('重开后忽略上一轮的导入失败', async () => {
  let rejectOld!: (error: Error) => void
  let resolveCurrent!: (panel: ComponentType) => void
  const load = vi
    .fn<() => Promise<ComponentType>>()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCurrent = resolve
        }),
    )
  const { user } = renderApp(<NamedFixture load={load} />)
  const open = screen.getByRole('button', { name: '打开设置' })
  await user.click(open)
  await user.keyboard('{Escape}')
  await user.click(open)
  await act(async () => rejectOld(new Error('上一轮失败')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('正在打开设置…')
  await act(async () => resolveCurrent(Loaded))
  expect(screen.getByText('浮层已加载')).toBeTruthy()
})

it('打开失败只显示对应面板的错误，允许重试、关闭、再次打开', async () => {
  const load = vi
    .fn<() => Promise<ComponentType>>()
    .mockRejectedValueOnce(new Error('离线'))
    .mockRejectedValueOnce(new Error('离线'))
    .mockResolvedValueOnce(Loaded)
  const { user } = renderApp(<NamedFixture load={load} />)
  const open = screen.getByRole('button', { name: '打开设置' })
  await user.click(open)
  expect((await screen.findByRole('alert')).textContent).toBe('设置加载失败')
  expect(screen.queryByRole('status')).toBeNull()
  await user.click(screen.getByRole('button', { name: '重试' }))
  expect((await screen.findByRole('alert')).textContent).toBe('设置加载失败')
  await user.click(screen.getByRole('button', { name: '关闭' }))
  expect(document.querySelector('[data-plein-pending-panel]')).toBeNull()
  await user.click(open)
  expect(await screen.findByText('浮层已加载')).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(3)
})
