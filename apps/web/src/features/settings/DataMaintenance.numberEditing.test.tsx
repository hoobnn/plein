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
  put?(request: Request): Response
}

function serve({ put }: Handlers = {}) {
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/maintenance/status') return Response.json(status)
    if (path === '/api/maintenance/space') return Response.json(space)
    if (path === '/api/maintenance/settings')
      return request.method === 'PUT'
        ? (put?.(request) ?? Response.json(status))
        : Response.json(status)
    return undefined
  })
}

const field = (label: string) => screen.getByRole<HTMLInputElement>('spinbutton', { name: label })
const save = () => screen.getByRole('button', { name: '保存设置' })

describe('维护设置的数值编辑', () => {
  it('清空后不提交，标出无效并把焦点留在出错的字段上', async () => {
    const fetch = serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('24'))

    const interval = field('备份间隔（小时）')
    fireEvent.change(interval, { target: { value: '' } })
    save().click()

    await waitFor(() => expect(interval.getAttribute('aria-invalid')).toBe('true'))
    expect(interval.getAttribute('aria-describedby')).toBeTruthy()
    // 没有真正保存
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
  })

  // 每个字段各自的边界：负数、小数、超过上限
  it.each([
    { label: '备份间隔（小时）', bad: '-1', hint: /请输入 1–720 之间的整数/ },
    { label: '保留最近几份', bad: '1.5', hint: /请输入 1–100 之间的整数/ },
    { label: '未引用素材保留（天）', bad: '3651', hint: /请输入 1–3650 之间的整数/ },
  ])('$label 的 $bad 不提交，写明范围并把焦点留在该字段', async ({ label, bad, hint }) => {
    const fetch = serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field(label).value).not.toBe(''))

    const input = field(label)
    fireEvent.change(input, { target: { value: bad } })
    // 原生约束校验在 happy-dom 里不会自己触发，按浏览器的顺序补上
    fireEvent.invalid(input)
    save().click()

    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByText(hint)).toBeTruthy()
    // 焦点留在出错的字段上，用户不用再找一次
    expect(document.activeElement).toBe(input)
    // 没有真正保存
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
  })

  it('保存失败保留草稿与错误，改正后能真正保存', async () => {
    let failing = true
    const fetch = serve({
      put: () =>
        failing
          ? Response.json({ error: 'test_failure', message: '保存暂不可用' }, { status: 503 })
          : Response.json(status),
    })
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('24'))

    const interval = field('备份间隔（小时）')
    fireEvent.change(interval, { target: { value: '12' } })
    save().click()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存暂不可用'))
    // 草稿还在
    expect(interval.value).toBe('12')

    failing = false
    save().click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('维护设置已保存'))
    expect(interval.getAttribute('aria-invalid')).toBeNull()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2)
  })

  it('保存成功后草稿清空，改动不再提示未保存', async () => {
    serve()
    renderApp(<DataMaintenance />)
    await waitFor(() => expect(field('备份间隔（小时）').value).toBe('24'))

    const interval = field('备份间隔（小时）')
    fireEvent.change(interval, { target: { value: '12' } })
    save().click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('维护设置已保存'))

    // 再改一次：状态提示应被清掉，说明上一次的结果不再挂着
    fireEvent.change(interval, { target: { value: '13' } })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
