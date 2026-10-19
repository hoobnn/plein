import { zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { validateProjectZip } from './projectZip'

afterEach(() => vi.restoreAllMocks())
const zip = (comment?: string) =>
  Uint8Array.from(zipSync({ 'timeline.otio': new Uint8Array([1, 2, 3]) }, { comment }))

it('正常工程和带最长 ZIP 注释的工程均可读取', async () => {
  for (const comment of [undefined, '中文工程说明', 'x'.repeat(65_535)])
    await expect(validateProjectZip(new Blob([zip(comment)]))).resolves.toBeUndefined()
})

it('拒绝错误页面、只有开头的截断工程和追加垃圾的 ZIP', async () => {
  const good = zip()
  for (const data of [
    new Uint8Array(0),
    new TextEncoder().encode('<html>error</html>'),
    good.slice(0, 30),
    new Uint8Array([...good, 0]),
  ])
    await expect(validateProjectZip(new Blob([data]))).rejects.toThrow('ZIP')
})

it('较大工程只转换头尾小片段，不创建整包 ArrayBuffer', async () => {
  const data = Uint8Array.from(
    zipSync({ 'media/reference.wav': new Uint8Array(2 * 1024 * 1024) }, { level: 0 }),
  )
  const archive = new Blob([data])
  const native = Blob.prototype.arrayBuffer
  const sizes: number[] = []
  vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(function (this: Blob) {
    sizes.push(this.size)
    return native.call(this)
  })
  await validateProjectZip(archive)
  expect(sizes.length).toBeGreaterThan(0)
  expect(Math.max(...sizes)).toBeLessThanOrEqual(65_557)
  expect(archive.size).toBeGreaterThan(2 * 1024 * 1024)
})
