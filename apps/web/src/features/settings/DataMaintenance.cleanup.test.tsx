// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { DataMaintenance } from './DataMaintenance'

const settings = {
  autoBackup: false,
  intervalHours: 24,
  keepBackups: 7,
  unusedDays: 30,
  trashDays: 30,
}

const status = {
  settings,
  running: null,
  lastBackupAt: null,
  nextBackupAt: null,
  lastError: null,
  backups: [],
  trash: [],
  skippedSymlinks: [],
}

const space = {
  total: 0,
  assets: 0,
  originals: 0,
  thumbnails: 0,
  database: 0,
  temp: 0,
  backups: 0,
  trash: 0,
  restored: 0,
  other: 0,
  unusedAssets: 0,
  reclaimableBytes: 0,
}

const preview = {
  assets: 2,
  bytes: 500,
  unusedDays: 30,
  protectedAssets: 1,
  token: 'tok',
}

interface Handlers {
  preview?(request: Request): Response
  cleanup?(request: Request): Response
  status?(request: Request): Response
}

function serve({ preview: onPreview, cleanup, status: onStatus }: Handlers = {}) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return onStatus?.(request) ?? Response.json(status)
    if (path === '/api/maintenance/space') return Response.json(space)
    if (path === '/api/maintenance/cleanup/preview')
      return onPreview?.(request) ?? Response.json(preview)
    if (path === '/api/maintenance/cleanup')
      return cleanup?.(request) ?? Response.json({ id: 'trash-1', assets: 2, bytes: 500 })
    return undefined
  })
}

const inspect = () => screen.getByRole('button', { name: '检查可清理素材' })
const previewRegion = () => screen.queryByRole('region', { name: '清理预览' })

describe('数据维护的清理交互', () => {
  it('先看清预览再确认，预览里写明保留多少被引用的素材', async () => {
    serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(inspect()).toBeTruthy())

    inspect().click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())
    const region = previewRegion()!
    expect(region.textContent).toContain('将 2 个')
    expect(region.textContent).toContain('保留 1 个被引用的素材')
    // 预览阶段不发清理请求
    expect(screen.getByRole('button', { name: '确认移入回收站' })).toBeTruthy()
  })

  it('取消预览不执行清理，焦点回到检查按钮可以立即重新检查', async () => {
    const fetch = serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(inspect()).toBeTruthy())

    inspect().click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())
    screen.getByRole('button', { name: '取消' }).click()

    await waitFor(() => expect(previewRegion()).toBeNull())
    // 只有预检那一次 POST，清理没有发出去
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(inspect()).toBe(document.activeElement)
  })

  it('没有可清理素材时说明原因，不展示无效的确认操作', async () => {
    serve({
      preview: () =>
        Response.json({ assets: 0, bytes: 0, unusedDays: 30, protectedAssets: 0, token: 'tok' }),
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(inspect()).toBeTruthy())

    inspect().click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())
    expect(previewRegion()!.textContent).toContain('暂无可清理素材')
    expect(screen.queryByRole('button', { name: '确认移入回收站' })).toBeNull()
  })

  it('确认后真实执行清理并说明移入了多少素材', async () => {
    const fetch = serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(inspect()).toBeTruthy())

    inspect().click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())
    screen.getByRole('button', { name: '确认移入回收站' }).click()

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('已将 2 个素材移入回收站'),
    )
    expect(previewRegion()).toBeNull()
    // 预检 + 清理各一次
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
  })

  it('预检失败能重试，重试后才拿到预览', async () => {
    let failing = true
    serve({
      preview: () =>
        failing
          ? Response.json({ error: 'test_failure', message: '预检暂不可用' }, { status: 503 })
          : Response.json(preview),
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(inspect()).toBeTruthy())

    inspect().click()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('预检暂不可用'))
    failing = false
    inspect().click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())
  })

  it('维护状态读取失败可以重试，恢复后显示真实设置', async () => {
    let failing = true
    serve({
      status: () =>
        failing
          ? Response.json({ error: 'test_failure', message: '状态暂不可用' }, { status: 503 })
          : Response.json(status),
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('状态暂不可用'))

    failing = false
    screen.getByRole('button', { name: '重试读取维护状态' }).click()
    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: '备份间隔（小时）' })).toBeTruthy(),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('空间统计读取失败不影响其它分区，单独提示并可刷新', async () => {
    let failing = true
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/maintenance/status') return Response.json(status)
      if (path === '/api/maintenance/space')
        return failing
          ? Response.json({ error: 'test_failure', message: '统计暂不可用' }, { status: 503 })
          : Response.json(space)
      return undefined
    })
    renderApp(<DataMaintenance />)
    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: '备份间隔（小时）' })).toBeTruthy(),
    )
    await waitFor(() => expect(screen.getByText(/空间统计暂不可用：统计暂不可用/)).toBeTruthy())
    // 维护设置仍然可用
    fireEvent.change(screen.getByRole('spinbutton', { name: '备份间隔（小时）' }), {
      target: { value: '30' },
    })
    failing = false
    screen.getByRole('button', { name: '刷新' }).click()
    await waitFor(() => expect(screen.queryByText(/空间统计暂不可用/)).toBeNull())
  })
})
