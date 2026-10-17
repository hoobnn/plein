import type { UserTemplate } from '@plein/protocol'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { useTemplates } from './store'

vi.mock('../../api/client', () => ({
  api: { templates: vi.fn(), saveTemplate: vi.fn(), deleteTemplate: vi.fn() },
}))

const template = (id: string): UserTemplate => ({
  id,
  title: id,
  createdAt: 1,
  data: { plein: 1, elements: [{ id: 'frame', kind: 'frame' }], edges: [] },
})

beforeEach(() => {
  vi.resetAllMocks()
  useTemplates.setState({ templates: [] })
})

describe('用户模板列表生命周期', () => {
  it('并发读取共用请求，旧快照不复活已删除模板或丢掉新模板', async () => {
    useTemplates.setState({ templates: [template('removed')] })
    let resolve!: (items: UserTemplate[]) => void
    vi.mocked(api.templates).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const first = useTemplates.getState().load()
    const second = useTemplates.getState().load()
    expect(api.templates).toHaveBeenCalledTimes(1)
    vi.mocked(api.saveTemplate).mockResolvedValueOnce(template('new'))
    vi.mocked(api.deleteTemplate).mockResolvedValueOnce(undefined)
    await useTemplates.getState().save('new', template('new').data)
    await useTemplates.getState().remove('removed')
    resolve([template('removed'), template('remote')])
    await Promise.all([first, second])
    expect(useTemplates.getState().templates).toEqual([template('new'), template('remote')])
  })

  it('读取失败保留模板，之后能够重新读取', async () => {
    useTemplates.setState({ templates: [template('local')] })
    vi.mocked(api.templates).mockRejectedValueOnce(new Error('离线'))
    await useTemplates.getState().load()
    expect(useTemplates.getState().templates).toEqual([template('local')])
    vi.mocked(api.templates).mockResolvedValueOnce([template('remote')])
    await useTemplates.getState().load()
    expect(useTemplates.getState().templates).toEqual([template('remote')])
  })

  it('列表先读到已保存的模板时，晚到的保存响应覆盖该条目并置顶，不重复插入', async () => {
    let resolveList!: (items: UserTemplate[]) => void
    let resolveSave!: (item: UserTemplate) => void
    vi.mocked(api.templates).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveList = done
        }),
    )
    vi.mocked(api.saveTemplate).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveSave = done
        }),
    )
    const loading = useTemplates.getState().load()
    const saving = useTemplates.getState().save('created', template('created').data)
    resolveList([template('remote'), template('created')])
    await loading
    const saved = { ...template('created'), title: '保存响应里的版本' }
    resolveSave(saved)
    await expect(saving).resolves.toEqual(saved)
    expect(useTemplates.getState().templates).toEqual([saved, template('remote')])
  })
})
