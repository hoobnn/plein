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

it('来源在读取完成前失效时不交出旧文件，保留队列且不创建 Blob URL', async () => {
  let current = true
  vi.spyOn(api, 'assetBlob').mockImplementation(async () => {
    current = false
    return new Blob(['old'])
  })
  expect(await downloadAll(items, new AbortController().signal, vi.fn(), () => current)).toEqual({
    started: 0,
    failed: [],
    remaining: items,
  })
  expect(click).not.toHaveBeenCalled()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})

it.each([
  ['封面.jpg', 'image/png', '封面.jpg.png'],
  ['角色.JPEG', 'image/jpeg', '角色.JPEG'],
  ['构图.v3', 'image/svg+xml', '构图.v3.svg'],
  ['图标.v1', 'image/vnd.microsoft.icon', '图标.v1.ico'],
  ['台词.final', 'audio/wav', '台词.final.wav'],
  ['成片.v1.2', 'video/mp4', '成片.v1.2.mp4'],
  ['分镜.v2', 'image/png', '分镜.v2.png'],
  ['角色.PNG', 'image/png', '角色.PNG'],
  ['历史.PNG', 'image/png', '历史.PNG'],
  ['历史.v2', 'image/png', '历史.v2.png'],
])('下载标题 %s 按实际格式 %s 补扩展名为 %s，并交出原文件', async (name, type, expected) => {
  const anchors: { download?: string }[] = []
  vi.stubGlobal('document', {
    createElement: () => {
      const a: { click: typeof click; remove: typeof remove; download?: string } = {
        click,
        remove,
      }
      anchors.push(a)
      return a
    },
    body: { appendChild: vi.fn() },
  })
  const blob = new Blob(['source'], { type })
  vi.spyOn(api, 'assetBlob').mockResolvedValue(blob)
  expect(
    await downloadAll([{ assetId: 'a', name }], new AbortController().signal, vi.fn()),
  ).toEqual({ started: 1, failed: [], remaining: [] })
  expect(anchors.map((a) => a.download)).toEqual([expected])
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
})
