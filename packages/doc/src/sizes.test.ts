import { describe, expect, it } from 'vite-plus/test'
import { aspectSize, mediaSize, nodeSize, parseAspect } from './sizes'

describe('元素默认尺寸', () => {
  it.each([
    ['16:9', 16 / 9],
    ['9：16', 9 / 16],
    ['2.39:1', 2.39],
    ['0:1', null],
    ['auto', null],
    [undefined, null],
  ])('画幅 %s → %s', (v, r) => {
    expect(parseAspect(v)).toBe(r)
  })

  it('长边固定，横竖都按比例', () => {
    expect(aspectSize(16 / 9)).toEqual({ w: 400, h: 225 })
    expect(aspectSize(9 / 16, 800)).toEqual({ w: 450, h: 800 })
  })

  it('节点按输出类型取尺寸，出图 / 视频没有画幅时是方形', () => {
    expect(nodeSize('video', 16 / 9)).toEqual({ w: 400, h: 225 })
    expect(nodeSize('image', null)).toEqual({ w: 320, h: 320 })
    expect(nodeSize('audio', 2)).toEqual({ w: 300, h: 160 })
    expect(nodeSize('text', null)).toEqual({ w: 280, h: 200 })
  })

  it('素材缩到长边 480 不放大，缺尺寸时用默认', () => {
    expect(mediaSize('image', 1920, 1080)).toEqual({ w: 480, h: 270 })
    expect(mediaSize('video', 1080, 1920)).toEqual({ w: 270, h: 480 })
    expect(mediaSize('image', 200, 100)).toEqual({ w: 200, h: 100 })
    expect(mediaSize('image')).toEqual({ w: 320, h: 240 })
    expect(mediaSize('video')).toEqual({ w: 480, h: 270 })
    expect(mediaSize('audio', 10, 10)).toEqual({ w: 384, h: 96 })
  })
})
