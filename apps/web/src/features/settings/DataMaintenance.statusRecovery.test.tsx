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

interface Handlers {
  status?(request: Request): Response
  backup?(request: Request): Response
}

function serve({ status: onStatus, backup }: Handlers = {}) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return onStatus?.(request) ?? Response.json(status)
    if (path === '/api/maintenance/space') return Response.json(space)
    if (path === '/api/maintenance/backups')
      return (
        backup?.(request) ?? Response.json({ id: 'b1', createdAt: 1, bytes: 10, path: '/tmp/b1' })
      )
    return undefined
  })
}

const retained = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: '保留最近几份' })

describe('维护状态的读取失败与恢复', () => {
  it('首次读取失败可手动重试，不必等自动轮询', async () => {
    let failing = true
    serve({
      status: () =>
        failing
          ? Response.json({ error: 'test_failure', message: '维护状态暂不可用' }, { status: 503 })
          : Response.json(status),
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('维护状态暂不可用'))

    failing = false
    screen.getByRole('button', { name: '重试读取维护状态' }).click()
    await waitFor(() => expect(screen.getByRole('region', { name: '自动备份' })).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('备份成功后读取失败，保留操作结果与设置草稿，重试不重复备份', async () => {
    // 先正常读到设置，再让备份后的读取失败
    let failing = false
    let submitted = 0
    const fetch = serve({
      status: () =>
        failing
          ? Response.json(
              { error: 'test_failure', message: '备份后的状态读取失败' },
              { status: 503 },
            )
          : Response.json(status),
      backup: () => {
        submitted++
        return Response.json({ id: 'b1', createdAt: 1, bytes: 10, path: '/tmp/b1' })
      },
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(retained().value).toBe('7'))

    // 用户改了设置
    fireEvent.change(retained(), { target: { value: '8' } })

    failing = true
    screen.getByRole('button', { name: '立即备份' }).click()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('备份后的状态读取失败'),
    )
    // 备份本身成功了，结果要留着
    expect(screen.getByRole('status').textContent).toContain('备份完成')
    // 设置草稿也留着
    expect(retained().value).toBe('8')

    // 重试读取不重复备份
    failing = false
    screen.getByRole('button', { name: '重试读取维护状态' }).click()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(submitted).toBe(1)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })
})
