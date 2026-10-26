import { describe, expect, it } from 'vite-plus/test'
import { ShotAnalysisManifest, shotAnalysisAssets, shotAnalysisRanges } from './shotAnalysis'

const manifest = (): ShotAnalysisManifest => ({
  version: 1,
  source: { assetId: 'a'.repeat(64), kind: 'video', mime: 'video/mp4' },
  timeBasis: 'first-video-frame',
  firstVideoPts: 5,
  duration: 2,
  algorithm: {
    name: 'ffmpeg-scene',
    version: 1,
    threshold: 0.3,
    minSceneSeconds: 0.4,
    manual: true,
  },
  scenes: [
    {
      id: 'one',
      start: 0,
      end: 1,
      frame: {
        assetId: 'b'.repeat(64),
        kind: 'image',
        mime: 'image/jpeg',
        at: 0.5,
        actualAt: 0,
        actualEnd: 1,
      },
    },
    {
      id: 'two',
      start: 1,
      end: 2,
      frame: {
        assetId: 'c'.repeat(64),
        kind: 'image',
        mime: 'image/jpeg',
        at: 1.5,
        actualAt: 1,
        actualEnd: 2,
      },
    },
  ],
  notes: [],
})

describe('本地拉片清单契约', () => {
  it('采样请求与实际持帧时间分别保存，资产引用显式去重', () => {
    const value = manifest()
    value.scenes[1]!.frame.actualAt = 0
    value.scenes[1]!.frame.actualEnd = 2
    value.scenes[1]!.frame.assetId = 'b'.repeat(64)
    expect(ShotAnalysisManifest.safeParse(value).success).toBe(true)
    expect(shotAnalysisAssets(value)).toEqual(['a'.repeat(64), 'b'.repeat(64)])
    expect(shotAnalysisAssets({ assetId: 'd'.repeat(64) })).toEqual([])
  })

  it.each([
    [
      '不是从零开始',
      (value: ShotAnalysisManifest) => {
        value.scenes[0]!.start = 0.1
      },
    ],
    [
      '区间留洞',
      (value: ShotAnalysisManifest) => {
        value.scenes[1]!.start = 1.1
      },
    ],
    [
      '区间重叠',
      (value: ShotAnalysisManifest) => {
        value.scenes[1]!.start = 0.9
      },
    ],
    [
      '零长度',
      (value: ShotAnalysisManifest) => {
        value.scenes[0]!.end = 0
      },
    ],
    [
      '未覆盖末尾',
      (value: ShotAnalysisManifest) => {
        value.scenes[1]!.end = 1.9
      },
    ],
    [
      '重复身份',
      (value: ShotAnalysisManifest) => {
        value.scenes[1]!.id = 'one'
      },
    ],
    [
      '请求采样不在镜头内',
      (value: ShotAnalysisManifest) => {
        value.scenes[0]!.frame.at = 1
      },
    ],
    [
      '实际帧未覆盖请求',
      (value: ShotAnalysisManifest) => {
        value.scenes[0]!.frame.actualEnd = 0.4
      },
    ],
    [
      '未来帧冒充当前帧',
      (value: ShotAnalysisManifest) => {
        value.scenes[0]!.frame.actualAt = 0.6
      },
    ],
    [
      '资产 hash 非法',
      (value: ShotAnalysisManifest) => {
        value.scenes[0]!.frame.assetId = 'bad'
      },
    ],
    [
      'MIME 非法',
      (value: ShotAnalysisManifest) => {
        value.source.mime = 'image/png'
      },
    ],
    [
      'notes 超限',
      (value: ShotAnalysisManifest) => {
        value.notes = ['a'.repeat(1001)]
      },
    ],
  ])('%s 的清单不能进入 UI 或强引用扫描', (_, mutate) => {
    const value = manifest()
    mutate(value)
    expect(ShotAnalysisManifest.safeParse(value).success).toBe(false)
    expect(shotAnalysisAssets(value)).toEqual([])
  })

  it('人工切点严格有序且位于内部，不自动排序或越界修正', () => {
    expect(shotAnalysisRanges(2, [0.2, 0.4])).toEqual([
      { start: 0, end: 0.2 },
      { start: 0.2, end: 0.4 },
      { start: 0.4, end: 2 },
    ])
    for (const points of [
      [0],
      [2],
      [1, 0.5],
      [1, 1],
      [Number.NaN],
      Array.from({ length: 100 }, (_, index) => (index + 1) / 100),
    ])
      expect(() => shotAnalysisRanges(2, points)).toThrow()
  })
})
