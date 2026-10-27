// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor } from '../../testing/render'
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
  backups: [{ id: 'b1', createdAt: 1, bytes: 10, path: '/tmp/b1' }],
  trash: [],
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

interface Handlers {
  restore?(request: Request): Response
}

function serve({ restore }: Handlers = {}) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return Response.json(status)
    if (path === '/api/maintenance/space') return Response.json(space)
    if (path === '/api/maintenance/backups')
      return Response.json({ id: 'b2', createdAt: 2, bytes: 20, path: '/tmp/b2' })
    if (path.includes('/restore-copy'))
      return (
        restore?.(request) ??
        Response.json({ path: '/tmp/restored/b1', assets: 3, bytes: 10, createdAt: 1 })
      )
    return undefined
  })
}

const restoreButton = () => screen.getByRole('button', { name: '恢复副本' })

describe('恢复副本的反馈', () => {
  it('恢复失败可重试，成功后写出恢复到的目录与后续说明', async () => {
    let failing = true
    serve({
      restore: () =>
        failing
          ? Response.json({ error: 'test_failure', message: '恢复暂不可用' }, { status: 503 })
          : Response.json({ path: '/tmp/restored/b1', assets: 3, bytes: 10, createdAt: 1 }),
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(restoreButton()).toBeTruthy())

    restoreButton().click()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('恢复暂不可用'))
    // 失败后按钮还能再点
    expect((restoreButton() as HTMLButtonElement).disabled).toBe(false)

    failing = false
    restoreButton().click()
    await waitFor(() => expect(screen.getByText(/已恢复到：/)).toBeTruthy())
    expect(screen.getByText(/已恢复到：/).textContent).toContain('/tmp/restored/b1')
    // 后续说明要写清楚：当前数据仍在用，怎么用这个副本
    expect(screen.getByText(/当前数据仍在使用/)).toBeTruthy()
  })

  it('恢复完成后执行别的维护操作，不再显示上一次的恢复指引', async () => {
    serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(restoreButton()).toBeTruthy())

    restoreButton().click()
    await waitFor(() => expect(screen.getByText(/已恢复到：/)).toBeTruthy())

    screen.getByRole('button', { name: '立即备份' }).click()
    await waitFor(() => expect(screen.queryByText(/已恢复到：/)).toBeNull())
  })
})
