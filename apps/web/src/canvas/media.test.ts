import type { Asset } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import {
  batchMediaOps,
  mediaTargetsFor,
  type MediaTarget,
  clampRange,
  validSpeed,
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

  it('拒绝无效或越界倍数，合法倍数不被改写', () => {
    for (const speed of [0, -1, 0.249, 4.01, Number.NaN, Infinity, -Infinity])
      expect(validSpeed(speed)).toBeNull()
    for (const speed of [0.25, 4, 2, 1.234]) expect(validSpeed(speed)).toBe(speed)
  })
  it('保留毫秒区间，不因取整把有效范围变成零长度', () => {
    expect(clampRange(0.101, 0.104, 2)).toEqual({ start: 0.101, end: 0.104 })
  })
  it('拒绝非有限入点和出点', () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(clampRange(value, 1, 2)).toBeNull()
      expect(clampRange(0, value, 2)).toBeNull()
    }
  })
})

describe('裁剪框', () => {
  it('视频宽高为偶数、奇数起点保留，图片仍允许奇数宽高', () => {
    const rect = { left: 1, top: 3, width: 20, height: 10 }
    expect(cropRect(rect, { kind: 'video' })).toEqual(rect)
    expect(cropRect({ ...rect, width: 19 }, { kind: 'video' })).toMatchObject({
      field: 'width',
      error: expect.stringContaining('偶数'),
    })
    expect(cropRect({ ...rect, height: 9 }, { kind: 'video' })).toMatchObject({ field: 'height' })
    expect(cropRect({ ...rect, width: 19 }, { kind: 'image' })).toEqual({ ...rect, width: 19 })
    expect(opsFor('video')).toContain('crop')
    expect(opsFor('video')).not.toContain('rotate')
    expect(opsFor('video')).not.toContain('flip')
  })
  it('默认整张图', () => {
    expect(
      cropRect({ left: 0, top: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
    ).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
  })

  it('明确超出范围的尺寸和起点报告到对应字段，不改写裁剪框', () => {
    expect(
      cropRect({ left: 1900, top: 1000, width: 400, height: 400 }, { width: 1920, height: 1080 }),
    ).toMatchObject({ field: 'width', error: expect.stringContaining('超出图片宽度') })
    expect(
      cropRect({ left: 30, top: 30, width: 20, height: 20 }, { width: 40, height: 20 }),
    ).toMatchObject({ field: 'top', error: expect.stringContaining('小于图片高度') })
    expect(
      cropRect({ left: 40, top: 0, width: Number.NaN, height: 20 }, { width: 40, height: 20 }),
    ).toMatchObject({ field: 'left' })
    expect(
      cropRect({ left: 0, top: 0, width: 20, height: 21 }, { width: 40, height: 20 }),
    ).toMatchObject({ field: 'height' })
  })
  it('拒绝负数、小数、非有限值及零尺寸，不把它们改成一像素', () => {
    const valid = { left: 0, top: 0, width: 40, height: 20 }
    for (const field of ['left', 'top', 'width', 'height'] as const) {
      for (const value of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(cropRect({ ...valid, [field]: value }, {})).toMatchObject({ field })
    }
    for (const field of ['width', 'height'] as const)
      expect(cropRect({ ...valid, [field]: 0 }, {})).toMatchObject({ field })
  })
  it('允许最后一像素和未知尺寸时明确填写的合法区域，服务端仍校验真实尺寸', () => {
    const last = { left: 39, top: 19, width: 1, height: 1 }
    expect(cropRect(last, { width: 40, height: 20 })).toEqual(last)
    expect(cropRect(last, {})).toEqual(last)
  })
})

describe('可用操作', () => {
  it('本机没有 ffmpeg 时不给视频加工项', () => {
    expect(opsFor('video', { ffmpeg: false, subtitles: false, rubberband: false })).toEqual([])
    expect(opsFor('video', { ffmpeg: true, subtitles: false, rubberband: false })).toHaveLength(5)
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

describe('混合批量加工的作用范围', () => {
  const targets: MediaTarget[] = ['image', 'video', 'audio'].map((kind) => ({
    elId: kind,
    assetId: `asset-${kind}`,
    kind: kind as MediaTarget['kind'],
  }))
  it.each(['image', 'video', 'audio'])(
    '以 %s 开头时菜单顺序一致，各操作只保留适用来源且不改原选择',
    (first) => {
      const ordered = [
        ...targets.filter((t) => t.kind === first),
        ...targets.filter((t) => t.kind !== first),
      ]
      const before = structuredClone(ordered)
      expect(batchMediaOps(ordered)).toEqual(['rotate', 'flip', 'speed', 'separate', 'frame'])
      expect(mediaTargetsFor(ordered, 'rotate').map((t) => t.elId)).toEqual(['image'])
      expect(mediaTargetsFor(ordered, 'speed').map((t) => t.elId)).toEqual(
        ordered.filter((t) => t.kind !== 'image').map((t) => t.elId),
      )
      expect(mediaTargetsFor(ordered, 'frame').map((t) => t.elId)).toEqual(['video'])
      expect(ordered).toEqual(before)
    },
  )
  it('没有 ffmpeg 时仅保留图片加工，不因首项音视频把图片操作一起隐藏', () => {
    const caps = { ffmpeg: false, subtitles: false, rubberband: false }
    const ordered = [targets[2]!, targets[1]!, targets[0]!]
    expect(batchMediaOps(ordered, caps)).toEqual(['rotate', 'flip'])
    expect(mediaTargetsFor(ordered, 'speed', caps)).toEqual([])
    expect(mediaTargetsFor(ordered, 'rotate', caps)).toEqual([targets[0]])
  })
  it('空选择和不支持的文件不产生加工目标或空菜单操作', () => {
    expect(batchMediaOps([])).toEqual([])
    expect(batchMediaOps([{ elId: 'pdf', assetId: 'pdf', kind: 'file' }])).toEqual([])
    expect(mediaTargetsFor(targets, 'split')).toEqual([targets[2]])
  })
})
