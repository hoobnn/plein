import type { Asset } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import {
  clampRange,
  clampSpeed,
  cropRect,
  deriveLabel,
  elementSize,
  evenSegments,
  formatTimecode,
  opsFor,
  parseTimecode,
  quickOpsFor,
} from './media'

const asset = (over: Partial<Asset> = {}) =>
  ({
    id: 'a'.repeat(64),
    kind: 'image',
    mime: 'image/png',
    name: '图.png',
    size: 1,
    variants: [],
    createdAt: 0,
    ...over,
  }) as Asset

describe('时间码', () => {
  it('认得秒、分秒、时分秒', () => {
    expect(parseTimecode('12.5')).toBe(12.5)
    expect(parseTimecode('1:02')).toBe(62)
    expect(parseTimecode('1:02.5')).toBe(62.5)
    expect(parseTimecode('00:01:02')).toBe(62)
    expect(parseTimecode(' 0:03 ')).toBe(3)
  })

  it('看不懂的一律 null，不会当成 0 秒', () => {
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('1:2:3:4')).toBeNull()
    expect(parseTimecode('-1')).toBeNull()
  })

  it('回显两位补零，超过一小时带小时位', () => {
    expect(formatTimecode(62.5)).toBe('1:02.5')
    expect(formatTimecode(3)).toBe('0:03')
    expect(formatTimecode(3723)).toBe('1:02:03')
    expect(formatTimecode(-1)).toBe('0:00')
  })
})

describe('区间与倍数', () => {
  it('夹住超出素材长度的区间，倒挂返回 null', () => {
    expect(clampRange(1, 3, 4)).toEqual({ start: 1, end: 3 })
    expect(clampRange(1, 9, 4)).toEqual({ start: 1, end: 4 })
    expect(clampRange(-2, 2, 4)).toEqual({ start: 0, end: 2 })
    expect(clampRange(3, 1, 4)).toBeNull()
    expect(clampRange(5, 9, 4)).toBeNull()
    // 不知道时长时只查倒挂
    expect(clampRange(0, 120)).toEqual({ start: 0, end: 120 })
  })

  it('切分给出可用的默认区间', () => {
    expect(evenSegments(6, 3)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
    ])
    // 末段不能超过总长，段数夹在 2–12
    expect(evenSegments(5, 3).at(-1)).toEqual({ start: 3.33, end: 5 })
    expect(evenSegments(5, 1)).toHaveLength(2)
    expect(evenSegments(5, 99)).toHaveLength(12)
  })

  it('变速倍数夹在服务端允许的范围里', () => {
    expect(clampSpeed(2)).toBe(2)
    expect(clampSpeed(0.1)).toBe(0.25)
    expect(clampSpeed(9)).toBe(4)
    expect(clampSpeed(1.234)).toBe(1.23)
  })
})

describe('裁剪框', () => {
  it('默认整张图', () => {
    expect(
      cropRect({ left: 0, top: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
    ).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
  })

  it('超出图片范围的部分收回来，不产生非法请求', () => {
    expect(
      cropRect({ left: 1900, top: 1000, width: 400, height: 400 }, { width: 1920, height: 1080 }),
    ).toEqual({ left: 1900, top: 1000, width: 20, height: 80 })
    expect(
      cropRect({ left: 30, top: 30, width: 20, height: 20 }, { width: 40, height: 20 }),
    ).toEqual({ left: 30, top: 19, width: 10, height: 1 })
  })
})

describe('可用操作', () => {
  it('本机没有 ffmpeg 时不给视频加工项', () => {
    expect(opsFor('video', { ffmpeg: false, subtitles: false, rubberband: false })).toEqual([])
    expect(opsFor('video', { ffmpeg: true, subtitles: false, rubberband: false })).toHaveLength(4)
    // 图片加工不靠 ffmpeg
    expect(opsFor('image', { ffmpeg: false, subtitles: false, rubberband: false })).not.toEqual([])
  })

  it('多选的一键操作都是不用填参数的那些', () => {
    // crop / trim / split 要填坐标或区间，只能单个素材用
    for (const kind of ['image', 'audio', 'video'] as const) {
      const quick = quickOpsFor(kind)
      expect(quick.length).toBeGreaterThan(0)
      expect(opsFor(kind)).toEqual(expect.arrayContaining(quick))
      for (const op of ['crop', 'trim', 'split'] as const) expect(quick).not.toContain(op)
    }
  })
})

describe('来源描述', () => {
  it('把参数说成人话', () => {
    expect(deriveLabel('crop', { left: 10, top: 20, width: 30, height: 40 })).toBe(
      '30×40 @ (10,20)',
    )
    expect(deriveLabel('rotate', { angle: 90 })).toBe('90°')
    expect(deriveLabel('flip', { axis: 'horizontal' })).toBe('左右翻转')
    expect(deriveLabel('trim', { start: 1, end: 62.5 })).toBe('0:01 – 1:02.5')
    expect(deriveLabel('speed', { speed: 2, keepPitch: true })).toBe('2×')
    expect(deriveLabel('speed', { speed: 2, keepPitch: false })).toBe('2×（变调）')
    expect(deriveLabel('split', { segments: [{}, {}, {}] })).toBe('3 段')
    expect(deriveLabel('frame', { at: 12.5 })).toBe('0:12.5')
  })
})

describe('画布元素尺寸', () => {
  it('媒体资产按资产类型落成元素（尺寸规则见 @plein/doc sizes），其他文件不落', () => {
    expect(elementSize(asset({ kind: 'video', width: 1080, height: 1920 }))).toEqual({
      kind: 'video',
      w: 270,
      h: 480,
    })
    expect(elementSize(asset({ kind: 'file' }))).toBeNull()
  })
})
