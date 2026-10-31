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

const status = (skippedSymlinks: string[]) => ({
  settings,
  running: null,
  lastBackupAt: null,
  nextBackupAt: null,
  lastError: null,
  backups: [],
  trash: [],
  skippedSymlinks,
})

const serve = (skippedSymlinks: string[]) =>
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return Response.json(status(skippedSymlinks))
    if (path === '/api/maintenance/space') return Response.json(space)
    return undefined
  })

const warning = () => screen.getByRole('alert').textContent ?? ''

describe('数据维护的符号链接警告', () => {
  it('有跳过项时提示数量和路径，以及如何纳入管理', async () => {
    serve(['assets/69/69a8', 'providers.json'])
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(warning()).toContain('以下 2 个条目'))
    expect(warning()).toContain('已跳过统计、清理和备份')
    expect(warning()).toContain('assets/69/69a8')
    expect(warning()).toContain('providers.json')
    expect(warning()).toContain('把原文件复制回该位置替换链接')
    // 没有超出展示上限时不出现折叠入口
    expect(screen.queryByText(/其余 /)).toBeNull()
  })

  it('没有跳过项时不显示警告', async () => {
    serve([])
    renderApp(<DataMaintenance />)
    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: '备份间隔（小时）' })).toBeTruthy(),
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('超过 5 条时只列 5 条，其余折叠在展开项里', async () => {
    const paths = [
      'assets/69/69a8',
      'assets/7a/7a11',
      'assets/be/be22',
      'plugins/extra',
      'providers.json',
      'models.json',
      'tmp/link',
    ]
    serve(paths)
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(warning()).toContain('以下 7 个条目'))
    // 折叠部分默认收起（textContent 含隐藏内容，不能用 contains 判断折叠）；
    // happy-dom 不实现 summary 点击展开，直接置 open 验证内容完整
    const details = screen.getByText('其余 2 个').closest('details')!
    expect(details.open).toBe(false)
    details.open = true
    expect(warning()).toContain('models.json')
    expect(warning()).toContain('tmp/link')
  })
})
