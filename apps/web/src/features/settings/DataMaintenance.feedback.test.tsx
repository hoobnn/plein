// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor } from '../../testing/render'
import { DataMaintenance } from './DataMaintenance'

const status = {
  settings: {
    autoBackup: false,
    intervalHours: 24,
    keepCount: 7,
    unusedDays: 30,
    trashDays: 30,
  },
  running: null,
  lastBackupAt: null,
  nextBackupAt: null,
  lastError: null,
  backups: [],
  trash: [],
}

const space = {
  total: 1000,
  assets: 0,
  originals: 0,
  thumbnails: 0,
  database: 1000,
  temp: 0,
  backups: 0,
  trash: 0,
  restored: 0,
  other: 0,
  unusedAssets: 2,
  reclaimableBytes: 500,
}

interface Handlers {
  preview?(request: Request): Response
  cleanup?(request: Request): Response
  backup?(request: Request): Response
}

function serve({ preview, cleanup, backup }: Handlers = {}) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return Response.json(status)
    if (path === '/api/maintenance/space') return Response.json(space)
    if (path === '/api/maintenance/cleanup/preview')
      return (
        preview?.(request) ??
        Response.json({ assets: 2, bytes: 500, unusedDays: 30, protectedAssets: 1, token: 'tok' })
      )
    if (path === '/api/maintenance/cleanup')
      return cleanup?.(request) ?? Response.json({ id: 'trash-1', assets: 2, bytes: 500 })
    if (path === '/api/maintenance/backups')
      return (
        backup?.(request) ?? Response.json({ id: 'b1', createdAt: 1, bytes: 10, path: '/tmp/b1' })
      )
    return undefined
  })
}

const previewRegion = () => screen.queryByRole('region', { name: '清理预览' })

describe('数据维护的操作反馈', () => {
  it('清理失败后作废预检结果，要求重新检查', async () => {
    serve({
      cleanup: () =>
        Response.json({ error: 'expired', message: '预检已过期，请重新检查' }, { status: 409 }),
    })
    renderApp(<DataMaintenance />)
    await screen.findByRole('button', { name: '检查可清理素材' })
    screen.getByRole('button', { name: '检查可清理素材' }).click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())

    screen.getByRole('button', { name: '确认移入回收站' }).click()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('预检已过期'))
    // 令牌用过即废，不能拿旧结果再试
    expect(previewRegion()).toBeNull()
  })

  it('别的操作失败不清掉已看过的清理预览', async () => {
    serve({
      backup: () =>
        Response.json({ error: 'maintenance_failed', message: '备份目录不可写' }, { status: 500 }),
    })
    renderApp(<DataMaintenance />)
    await screen.findByRole('button', { name: '检查可清理素材' })
    screen.getByRole('button', { name: '检查可清理素材' }).click()
    await waitFor(() => expect(previewRegion()).not.toBeNull())

    screen.getByRole('button', { name: '立即备份' }).click()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('备份目录不可写'))
    // 备份失败与清理预检无关，预览应当留着
    expect(previewRegion()).not.toBeNull()
  })
})
