import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import { downloadAll } from './grid'

const items = [
  { assetId: 'a', name: '甲' },
  { assetId: 'b', name: '乙' },
]
let click: ReturnType<typeof vi.fn>
let remove: ReturnType<typeof vi.fn>
let revoke: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers()
  click = vi.fn()
  remove = vi.fn()
  vi.stubGlobal('document', {
    createElement: () => ({ click, remove }),
    body: { appendChild: vi.fn() },
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('读取已返回但取消发生在保存前时，不交出文件并保留整个原队列', async () => {
  const controller = new AbortController()
  const read = vi.spyOn(api, 'assetBlob').mockImplementation(async () => {
    controller.abort()
    return new Blob(['source'])
  })
  const progress = vi.fn()
  expect(await downloadAll(items, controller.signal, progress)).toEqual({
    started: 0,
    failed: [],
    remaining: items,
  })
  expect(read).toHaveBeenCalledTimes(1)
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(click).not.toHaveBeenCalled()
  expect(progress).not.toHaveBeenCalled()
})

it('交给浏览器的点击抛错时清理锚点和 Blob，后续文件仍可下载且只重试失败项', async () => {
  vi.spyOn(api, 'assetBlob').mockResolvedValue(new Blob(['source']))
  click.mockImplementationOnce(() => {
    throw new Error('blocked')
  })
  const progress = vi.fn()
  const operation = downloadAll(items, new AbortController().signal, progress)
  await vi.advanceTimersByTimeAsync(250)
  expect(await operation).toEqual({ started: 1, failed: [items[0]], remaining: [items[0]] })
  expect(progress.mock.calls).toEqual([
    [0, 1],
    [1, 1],
  ])
  expect(remove).toHaveBeenCalledTimes(2)
  expect(revoke).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  expect(revoke).toHaveBeenCalledTimes(2)
})

it('文件已交出后取消只保留尚未处理的文件，不重复下载成功项', async () => {
  const controller = new AbortController()
  const read = vi.spyOn(api, 'assetBlob').mockResolvedValue(new Blob(['source']))
  click.mockImplementationOnce(() => controller.abort())
  const operation = downloadAll(items, controller.signal, vi.fn())
  await vi.advanceTimersByTimeAsync(250)
  expect(await operation).toEqual({ started: 1, failed: [], remaining: [items[1]] })
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(revoke).toHaveBeenCalledTimes(1)
})
