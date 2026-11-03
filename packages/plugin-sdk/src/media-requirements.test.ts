import { describe, expect, it } from 'vite-plus/test'
import {
  mediaBatchProblems,
  mediaRequirementOf,
  mediaRequirementProblems,
  mergeMediaRequirement,
} from './media-requirements'
import type { MediaRequirement } from './provider'

const title = '示例模型'

const videoRequirement: MediaRequirement = {
  mime: ['video/mp4', 'video/quicktime'],
  maxMB: 200,
  minEdge: 300,
  maxEdge: 6000,
  minRatio: 0.4,
  maxRatio: 2.5,
  minDuration: 2,
  maxDuration: 15,
  totalDurationMax: 15,
  videoCodecs: ['h264', 'hevc'],
  minFrameRate: 24,
  maxFrameRate: 60,
  audioCodecs: ['aac', 'mp3'],
  pcmAudioMimes: ['video/quicktime'],
}

const check = (sample: Parameters<typeof mediaRequirementProblems>[1], name?: string) =>
  mediaRequirementProblems(videoRequirement, sample, { title, label: '参考视频', name })

describe('素材要求的判定', () => {
  it('帧率不符时说清当前值与要求', () => {
    expect(check({ frameRate: 20 }, '片头')).toEqual([
      '参考视频「片头」帧率 20 fps，示例模型 要求 24–60 fps，请先转码再运行',
    ])
  })

  it('单段时长短于下限时说清当前秒数', () => {
    expect(check({ duration: 1 }, '片头')).toEqual([
      '参考视频「片头」只有 1 秒，示例模型 要求至少 2 秒，请换更长的素材',
    ])
  })

  it('宽高与比例不符时给出素材尺寸', () => {
    expect(check({ width: 300, height: 1024 })).toEqual([
      '参考视频 300×1024，宽高比 0.293，示例模型 要求宽高比 0.4–2.5，请更换素材',
    ])
  })

  it('格式不符时列出允许的格式', () => {
    expect(check({ mime: 'video/webm' })).toEqual([
      '参考视频格式 video/webm 不在允许范围（MP4、MOV），请先转换格式再运行',
    ])
  })

  it('大小超限时给出当前兆字节数', () => {
    expect(check({ size: 300 * 1024 * 1024 })).toEqual([
      '参考视频大小 300 MB，超过 示例模型 的 200 MB 上限，请压缩后再运行',
    ])
  })

  it('编码与音轨不符时按容器判断 PCM 是否允许', () => {
    expect(check({ videoCodec: 'vp9' })[0]).toContain('编码 VP9')
    expect(check({ audioCodecs: ['opus'] })[0]).toContain('音轨编码 Opus')
    expect(check({ mime: 'video/quicktime', audioCodecs: ['pcm_s16le'] })).toEqual([])
  })

  it('严格模式下读不到的信息算不满足，宽松模式跳过', () => {
    expect(
      mediaRequirementProblems(videoRequirement, {}, { title, label: '参考视频', strict: true })
        .length,
    ).toBeGreaterThan(0)
    expect(mediaRequirementProblems(videoRequirement, {}, { title, label: '参考视频' })).toEqual([])
  })

  it('没有声明要求时不产生任何问题', () => {
    expect(
      mediaRequirementProblems(undefined, { mime: 'video/webm' }, { title, label: '参考视频' }),
    ).toEqual([])
  })
})

describe('同类素材的合计时长', () => {
  it('合计超过上限时按类别点名', () => {
    expect(
      mediaBatchProblems({
        requirement: videoRequirement,
        samples: [{ sample: { duration: 8 } }, { sample: { duration: 8 } }],
        title,
        label: '参考视频',
      }),
    ).toEqual(['参考视频总时长 16 秒，超过 示例模型 的 15 秒上限，请缩短素材'])
  })

  it('参考视频与输出时长相加超限时说清两部分', () => {
    expect(
      mediaBatchProblems({
        requirement: { totalWithOutputMax: 30 },
        samples: [{ sample: { duration: 20 } }],
        title,
        label: '参考视频',
        outputDuration: 15,
      }),
    ).toEqual([
      '参考视频总时长 20 秒，加输出时长 15 秒，超过 示例模型 的 30 秒上限，请缩短素材或减少输出时长',
    ])
  })

  it('输出时长由模型决定时不与参考视频相加', () => {
    expect(
      mediaBatchProblems({
        requirement: { totalWithOutputMax: 30 },
        samples: [{ sample: { duration: 20 } }],
        title,
        label: '参考视频',
      }),
    ).toEqual([])
  })
})

describe('要求声明的合并', () => {
  it('任务模式的追加要求覆盖同类素材的要求', () => {
    const merged = mediaRequirementOf(
      { video: videoRequirement, videoTasks: { edit: { minDuration: 8 } } },
      'video',
      'edit',
    )
    expect(merged?.minDuration).toBe(8)
    expect(merged?.maxDuration).toBe(15)
    expect(mediaRequirementOf({ video: videoRequirement }, 'video', 'edit')?.minDuration).toBe(2)
  })

  it('首尾帧没单独声明时按参考图的要求', () => {
    expect(mediaRequirementOf({ image: videoRequirement }, 'frame')?.minEdge).toBe(300)
    expect(
      mediaRequirementOf({ image: videoRequirement, frame: { maxMB: 30 } }, 'frame')?.minEdge,
    ).toBeUndefined()
  })

  it('合并时以覆盖项为准', () => {
    expect(mergeMediaRequirement({ minDuration: 2, maxMB: 30 }, { minDuration: 8 })).toEqual({
      minDuration: 8,
      maxMB: 30,
    })
  })
})
