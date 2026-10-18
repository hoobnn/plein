import type { Catalog } from '@plein/protocol'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { useCatalog } from './catalog'

vi.mock('../api/client', () => ({ api: { catalog: vi.fn() } }))
const catalog = (ref: string): Catalog => ({
  plugins: [],
  nodes: [],
  providers: [],
  defaultModels: { 'text.chat': ref },
  templates: [],
  prompts: [],
  elements: [],
})
function pending() {
  let resolve!: (value: Catalog) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Catalog>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.mocked(api.catalog).mockReset()
  useCatalog.setState({ catalog: null, error: null })
})

it('较旧的目录响应不能覆盖后发请求已得到的新目录', async () => {
  const earlier = pending()
  const later = pending()
  vi.mocked(api.catalog).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise)
  const first = useCatalog.getState().load()
  const second = useCatalog.getState().load()
  const latest = catalog('plein/mock:new')
  later.resolve(latest)
  await second
  earlier.resolve(catalog('plein/mock:old'))
  await first
  expect(useCatalog.getState().catalog).toBe(latest)
})

it('旧请求迟到的错误不污染最新成功目录', async () => {
  const earlier = pending()
  const latest = catalog('plein/mock:new')
  vi.mocked(api.catalog).mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(latest)
  const first = useCatalog.getState().load()
  await useCatalog.getState().load()
  earlier.reject(new Error('旧请求失败'))
  await first
  expect(useCatalog.getState().catalog).toBe(latest)
  expect(useCatalog.getState().error).toBeNull()
})

it('最新请求失败时保留原目录与新错误，旧成功响应不能清掉错误', async () => {
  const previous = catalog('plein/mock:previous')
  useCatalog.setState({ catalog: previous })
  const earlier = pending()
  vi.mocked(api.catalog)
    .mockReturnValueOnce(earlier.promise)
    .mockRejectedValueOnce(new Error('最新读取失败'))
  const first = useCatalog.getState().load()
  await useCatalog.getState().load()
  earlier.resolve(catalog('plein/mock:old'))
  await first
  expect(useCatalog.getState().catalog).toBe(previous)
  expect(useCatalog.getState().error).toBe('最新读取失败')
})
