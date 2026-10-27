import { describe, expect, it, vi } from 'vite-plus/test'
import { uploadBatch } from './uploadBatch'

const image = (name: string) => new File(['image'], name, { type: 'image/png' })
describe('资产库批量上传', () => {
  it('单个失败不丢失之前成功项，也不跳过后续文件；提示列出失败文件', async () => {
    const files = [image('a.png'), image('b.png'), image('c.png')]
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockRejectedValueOnce(new Error('离线'))
      .mockResolvedValueOnce({ id: 'c' })
    const result = await uploadBatch(files, 'image', upload)
    expect(result.ids).toEqual(['a', 'c'])
    expect(result.failed).toBe(true)
    expect(result.message).toContain('已添加 2 张图片')
    expect(result.message).toContain('b.png')
    expect(result.message).toContain('离线')
    expect(upload.mock.calls.map(([file]) => file)).toEqual(files)
  })
  it('重选整批时按素材编号去重，保留顺序且不修改已有引用', async () => {
    const used = ['a']
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockResolvedValueOnce({ id: 'b' })
      .mockResolvedValueOnce({ id: 'b' })
    const result = await uploadBatch(
      [image('old.png'), image('b.png'), image('same.png')],
      'image',
      upload,
      { used },
    )
    expect(result).toEqual({ ids: ['b'], failed: false, message: '已跳过 2 张重复图片。' })
    expect(used).toEqual(['a'])
  })
  it('超过剩余数量时不发任何上传，零剩余也明确反馈', async () => {
    const upload = vi.fn()
    const result = await uploadBatch([image('a.png'), image('b.png')], 'image', upload, {
      capacity: 1,
    })
    expect(result).toMatchObject({ ids: [], failed: true })
    expect(result.message).toContain('最多还能添加 1 张')
    expect(
      (await uploadBatch([image('a.png')], 'image', upload, { capacity: 0 })).message,
    ).toContain('最多还能添加 0 张')
    expect(upload).not.toHaveBeenCalled()
  })
  it('只计算目标类型数量，混选非图片时保留成功项并告知跳过', async () => {
    const upload = vi.fn().mockResolvedValue({ id: 'a' })
    const text = new File(['text'], 'note.txt', { type: 'text/plain' })
    expect(await uploadBatch([text, image('a.png')], 'image', upload, { capacity: 1 })).toEqual({
      ids: ['a'],
      failed: false,
      message: '已跳过 1 个非图片文件。',
    })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(await uploadBatch([text], 'image', upload)).toEqual({
      ids: [],
      failed: true,
      message: '只能放图片',
    })
  })
  it('没有余量时说明是已达上限，而不是让用户「减少后再试」', async () => {
    const upload = vi.fn()
    const result = await uploadBatch([image('a.png')], 'image', upload, { capacity: 0 })
    expect(result.failed).toBe(true)
    expect(result.message).toContain('最多还能添加 0 张')
    expect(result.message).toContain('已达到图片数量上限')
    expect(result.message).toContain('请先移除一张已有图片再添加')
    expect(upload).not.toHaveBeenCalled()
  })
  it('满额文案按类型用量词：视频说「一个已有视频」，不说「一张」', async () => {
    const upload = vi.fn()
    const video = new File(['video'], 'a.mp4', { type: 'video/mp4' })
    const result = await uploadBatch([video], 'video', upload, { capacity: 0 })
    expect(result.failed).toBe(true)
    expect(result.message).toContain('已达到视频数量上限')
    expect(result.message).toContain('最多还能添加 0 个视频')
    expect(result.message).toContain('请先移除一个已有视频再添加')
    expect(result.message).not.toContain('一张')
    expect(upload).not.toHaveBeenCalled()
  })

  it('取消不产生错误；单文件错误保留原说明，网络异常也可恢复', async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('服务繁忙'))
      .mockRejectedValueOnce('连接中断')
      .mockResolvedValueOnce({ id: 'ok' })
    expect(await uploadBatch([], 'image', upload)).toEqual({
      ids: [],
      failed: false,
      message: null,
    })
    expect((await uploadBatch([image('a.png')], 'image', upload)).message).toBe('服务繁忙')
    expect((await uploadBatch([image('a.png')], 'image', upload)).message).toBe('连接中断')
    expect(await uploadBatch([image('a.png')], 'image', upload)).toEqual({
      ids: ['ok'],
      failed: false,
      message: null,
    })
  })
  it('多处失败全部列出，同一错误原因去重；视频数量与类型提示正确', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('繁忙'))
    const result = await uploadBatch([image('a.png'), image('b.png')], 'image', upload)
    expect(result.message).toContain('a.png、b.png')
    expect(result.message?.match(/繁忙/g)).toHaveLength(1)
    const videos = ['a.mp4', 'b.mp4'].map(
      (name) => new File(['video'], name, { type: 'video/mp4' }),
    )
    expect((await uploadBatch(videos, 'video', upload, { capacity: 1 })).message).toContain(
      '最多还能添加 1 个',
    )
    expect((await uploadBatch([image('a.png')], 'video', upload)).message).toBe('只能放视频')
  })
})
