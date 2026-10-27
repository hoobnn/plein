// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { DataMaintenance } from './DataMaintenance'

const defaults = {
  autoBackup: false,
  intervalHours: 24,
  keepBackups: 7,
  unusedDays: 30,
  trashDays: 30,
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

const statusOf = (settings: typeof defaults) => ({
  settings,
  running: null,
  lastBackupAt: null,
  nextBackupAt: null,
  lastError: null,
  backups: [],
  trash: [],
})

interface Handlers {
  /** 服务端当前存着的设置 */
  server?: typeof defaults
  put?(request: Request): Response
}

/** 维护设置：轮询会把服务端的新值带回来，PUT 记录提交的内容 */
function serve({ server = defaults, put }: Handlers = {}) {
  const fetch = mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return Response.json(statusOf(server))
    if (path === '/api/maintenance/space') return Response.json(space)
    if (path === '/api/maintenance/settings')
      return put?.(request) ?? Response.json(statusOf(server))
    return undefined
  })
  return fetch
}

const field = (label: string) => screen.getByRole<HTMLInputElement>('spinbutton', { name: label })
const toggle = () => screen.getByRole('switch', { name: '启用自动备份' })
const save = () => screen.getByRole('button', { name: '保存设置' })

/** 最近一次 PUT 提交出去的设置 */
function submitted(fetch: ReturnType<typeof mockFetch>) {
  const call = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)
  return call ? (JSON.parse(String(call[1]?.body)) as typeof defaults) : null
}

describe('维护设置与外部更新同步', () => {
  it('未编辑的数值与开关跟随服务端更新', async () => {
    vi.useFakeTimers()
    const server = { ...defaults }
    serve({ server })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('24'))

    // 服务端被别处改了：轮询带回新值，没编辑过的字段跟着变
    server.intervalHours = 52
    server.autoBackup = true
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('52'))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('保留已编辑的草稿，保存时合并其它已更新的字段', async () => {
    vi.useFakeTimers()
    const server = { ...defaults }
    const fetch = serve({ server })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('24'))

    // 用户改了两个字段
    fireEvent.change(field('备份间隔（小时）'), { target: { value: '12' } })
    fireEvent.click(toggle())

    // 期间别处改了另外两个字段
    server.keepBackups = 9
    server.unusedDays = 45

    await act(() => vi.advanceTimersByTimeAsync(10_000))
    await waitFor(() => expect(field('保留最近几份').value).toBe('9'))
    // 用户自己的草稿没有被覆盖
    expect(field('备份间隔（小时）').value).toBe('12')
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    save().click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('维护设置已保存'))
    expect(submitted(fetch)).toEqual({
      ...defaults,
      intervalHours: 12,
      autoBackup: true,
      keepBackups: 9,
      unusedDays: 45,
    })
  })

  it('保存响应迟到时，界面用的是实际保存下来的值', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const server = { ...defaults }
    const fetch = mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/maintenance/status') return Response.json(statusOf(server))
      if (path === '/api/maintenance/space') return Response.json(space)
      if (path === '/api/maintenance/settings') {
        if (request.method !== 'PUT') return Response.json(statusOf(server))
        // 服务端已经存下新值，但响应要等一会儿才回来
        server.intervalHours = 12
        return gate.then(() => Response.json(statusOf(server)))
      }
      return undefined
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('24'))

    fireEvent.change(field('备份间隔（小时）'), { target: { value: '12' } })
    save().click()

    // 响应还没回来：共享状态已经采用保存下来的值
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1),
    )
    release()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('维护设置已保存'))
    expect(field('备份间隔（小时）').value).toBe('12')
  })
})
