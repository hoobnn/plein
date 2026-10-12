import { describe, expect, it } from 'vitest'
import { cacheParams } from './runs'

describe('缓存键参数', () => {
  it('只算所选模型的专属参数，空的和留空的分辨率不算', () => {
    const base = { model: 'a:m', prompt: 'x', resolution: '', options: {} }
    expect(cacheParams(base)).toEqual({ model: 'a:m', prompt: 'x' })
    expect(
      cacheParams({
        ...base,
        resolution: '1080p',
        options: { 'a:m': { watermark: true }, 'b:n': { x: 1 } },
      }),
    ).toEqual({ model: 'a:m', prompt: 'x', resolution: '1080p', options: { watermark: true } })
    // 别的模型的设置改了不影响
    expect(cacheParams({ ...base, options: { 'b:n': { x: 2 } } })).toEqual(cacheParams(base))
    expect(cacheParams(base, ['prompt'])).toEqual({ model: 'a:m' })
  })
})
