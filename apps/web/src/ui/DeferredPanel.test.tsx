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

it('导入失败不进入全局错误页，下次打开重新加载', async () => {
  const load = vi
    .fn<() => Promise<ComponentType>>()
    .mockRejectedValueOnce(new Error('模块连接中断'))
    .mockResolvedValue(Loaded)
  const { user } = renderApp(<RetryFixture load={load} />)
  await user.click(screen.getByRole('button', { name: '切换浮层' }))
  expect((await screen.findByRole('status')).textContent).toBe('重要提示')
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('heading', { name: '主界面仍可用' })).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '切换浮层' }))
  await user.click(screen.getByRole('button', { name: '切换浮层' }))
  expect(await screen.findByText('浮层已加载')).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(2)
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
