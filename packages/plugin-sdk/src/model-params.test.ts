import { describe, expect, it } from 'vite-plus/test'
import { modelParamsProblem, transcribeAudioProblem } from './model-params'
import type { ModelInfo } from './provider'

const video: ModelInfo = {
  id: 'video-1',
  title: '测试视频',
  capabilities: ['video.generate'],
  limits: {
    duration: { min: 2, max: 15 },
    aspectRatios: ['16:9', '9:16'],
    count: { max: 2 },
  },
}

const speech: ModelInfo = {
  id: 'speech-1',
  title: '测试配音',
  capabilities: ['audio.speech'],
  limits: { speed: { min: 0.5, max: 2 } },
}

describe('时长按模型声明的范围校验', () => {
  it('视频、配乐、音效超出范围时报第一条问题', () => {
    expect(modelParamsProblem(video, 'video.generate', { duration: 30 })).toBe(
      '测试视频 的时长须为 2–15 秒，现在是 30 秒',
    )
    expect(modelParamsProblem(video, 'video.generate', { duration: 1 })).toContain(
      '时长须为 2–15 秒，现在是 1 秒',
    )
    const music: ModelInfo = {
      id: 'music-1',
      title: '测试配乐',
      capabilities: ['audio.music'],
      limits: { duration: { min: 5, max: 60 } },
    }
    expect(modelParamsProblem(music, 'audio.music', { duration: 300 })).toBe(
      '测试配乐 的时长须为 5–60 秒，现在是 300 秒',
    )
    const sfx: ModelInfo = {
      id: 'sfx-1',
      title: '测试音效',
      capabilities: ['audio.sfx'],
      limits: { duration: { min: 1, max: 10 } },
    }
    expect(modelParamsProblem(sfx, 'audio.sfx', { duration: 20 })).toBe(
      '测试音效 的时长须为 1–10 秒，现在是 20 秒',
    )
  })

  it('范围内的时长、自适应时长和不声明范围的模型都不报', () => {
    expect(modelParamsProblem(video, 'video.generate', { duration: 15 })).toBeNull()
    expect(modelParamsProblem(video, 'video.generate', { duration: -1 })).toBeNull()
    expect(modelParamsProblem(video, 'video.generate', {})).toBeNull()
    const free: ModelInfo = { id: 'free', title: '不限时长', capabilities: ['video.generate'] }
    expect(modelParamsProblem(free, 'video.generate', { duration: 30 })).toBeNull()
  })

  it('平台接管时长时按平台取值判，不按用户取值报', () => {
    const ref = 'volc/ark:doubao-seedance-2-5-260628'
    expect(
      modelParamsProblem(video, 'video.generate', {
        model: ref,
        mode: 'text',
        duration: 30,
        options: { [ref]: { adaptive_duration: true } },
      }),
    ).toBeNull()
  })
})

describe('视频的画幅与张数按模型声明校验', () => {
  it('画幅不在支持列表里时报问题', () => {
    expect(modelParamsProblem(video, 'video.generate', { aspectRatio: '4:3' })).toBe(
      '测试视频 不支持画幅 4:3',
    )
    expect(modelParamsProblem(video, 'video.generate', { aspectRatio: '16:9' })).toBeNull()
  })

  it('平台接管画幅时不按用户取值报', () => {
    expect(
      modelParamsProblem(video, 'video.generate', {
        model: 'minimax/api:MiniMax-H3',
        mode: 'image',
        duration: 5,
        aspectRatio: '4:3',
      }),
    ).toBeNull()
  })

  it('一次生成的条数超过上限时报问题', () => {
    expect(modelParamsProblem(video, 'video.generate', { count: 3 })).toBe(
      '测试视频 一次最多生成 2 条',
    )
    expect(modelParamsProblem(video, 'video.generate', { count: 2 })).toBeNull()
  })
})

describe('配音语速按模型声明校验', () => {
  it('语速超出范围时报问题', () => {
    expect(modelParamsProblem(speech, 'audio.speech', { speed: 3 })).toBe(
      '测试配音 的语速须为 0.5–2 倍',
    )
    expect(modelParamsProblem(speech, 'audio.speech', { speed: 1 })).toBeNull()
  })

  it('模型不支持调语速时要求恢复为 1', () => {
    const fixed: ModelInfo = {
      id: 'speech-fixed',
      title: '固定语速配音',
      capabilities: ['audio.speech'],
      limits: { speed: false },
    }
    expect(modelParamsProblem(fixed, 'audio.speech', { speed: 1.5 })).toBe(
      '固定语速配音 不支持调节语速，请把语速恢复为 1',
    )
    expect(modelParamsProblem(fixed, 'audio.speech', { speed: 1 })).toBeNull()
  })
})

describe('局部重绘的张数按模型声明校验', () => {
  it('一次生成超过上限时报问题', () => {
    const edit: ModelInfo = {
      id: 'edit-1',
      title: '测试局部重绘',
      capabilities: ['image.edit'],
      limits: { count: { max: 4 } },
    }
    expect(modelParamsProblem(edit, 'image.edit', { count: 5 })).toBe(
      '测试局部重绘 一次最多生成 4 张',
    )
    expect(modelParamsProblem(edit, 'image.edit', { count: 4 })).toBeNull()
  })

  it('图片生成不由这里管', () => {
    const image: ModelInfo = {
      id: 'image-1',
      title: '测试图片',
      capabilities: ['image.generate'],
      limits: { count: { max: 2 }, duration: { min: 1, max: 5 } },
    }
    expect(modelParamsProblem(image, 'image.generate', { count: 9, duration: 30 })).toBeNull()
  })
})

describe('语音识别音频预检', () => {
  const model: ModelInfo = {
    id: 'bigmodel',
    title: '录音文件识别极速版',
    capabilities: ['audio.transcribe'],
    limits: {
      media: { audio: { mime: ['audio/mpeg', 'audio/wav'], maxMB: 100, minBytes: 1 } },
    },
  }

  it('按资产记录的大小给出模型、上限、名字和当前值', () => {
    expect(transcribeAudioProblem(model, { size: 120 * 1024 * 1024 }, '旁白')).toBe(
      '录音文件识别极速版 要求音频不超过 100 MB，「旁白」是 120 MB，请压缩后再运行',
    )
    expect(transcribeAudioProblem(model, { size: 100 * 1024 * 1024 })).toBeNull()
    expect(transcribeAudioProblem(model, { size: 90 * 1024 * 1024 }, '旁白')).toBeNull()
  })

  it('空文件按最小大小拒绝，1 字节放行', () => {
    expect(transcribeAudioProblem(model, { size: 0 }, '旁白')).toBe(
      '录音文件识别极速版 要求音频不小于 1 字节，「旁白」是 0 字节，请更换素材',
    )
    expect(transcribeAudioProblem(model, { size: 1 }, '旁白')).toBeNull()
  })

  it('格式不对时用媒体的统一说法；没声明音频要求的模型不判', () => {
    expect(transcribeAudioProblem(model, { mime: 'audio/flac', size: 1024 }, '旁白')).toContain(
      '不在允许范围',
    )
    expect(
      transcribeAudioProblem(
        { id: 'x', title: 'X', capabilities: ['audio.transcribe'] },
        { size: 1024 * 1024 * 1024 },
      ),
    ).toBeNull()
  })
})
