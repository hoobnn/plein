import { sfxNode, speechNode, transcribeNode } from '@plein/nodes'
import type { ExecutorContext, ModelSpec, ProviderCallResult } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { sfx, transcription } from './audio'
import { coreServerPlugin } from './core'

const audio = { assetId: 'audio-one', kind: 'audio' as const, mime: 'audio/wav' }
const call = (result: Partial<ProviderCallResult> = {}) =>
  vi.fn(async () => ({ assets: [], outputs: [], ...result }))

describe('分镜语气与配音模型能力', () => {
  const spec: ModelSpec = {
    id: 'speech-2.8-hd',
    title: 'MiniMax TTS',
    capabilities: ['audio.speech'],
    limits: { instruction: false },
  }
  const speech = coreServerPlugin.executors.find((e) => e.node.type === 'plein/speech')!
  const fixture = (
    instruction: string,
    options: Record<string, unknown> = {},
    supportsInstruction = false,
  ) => {
    const model = supportsInstruction ? 'doubao/speech:tts' : 'minimax/api:speech-2.8-hd'
    const submit = call({ assets: [audio] })
    const ctx = {
      params: speechNode.params.parse({
        model,
        text: '你来了',
        instruction,
        options: { [model]: options },
      }),
      inputs: {},
      progress: vi.fn(),
      providers: {
        call: submit,
        models: () => [
          {
            ...spec,
            limits: { instruction: supportsInstruction },
            ref: model,
            provider: supportsInstruction ? 'doubao/speech' : 'minimax/api',
          },
        ],
      },
    } as unknown as ExecutorContext
    return { ctx, submit, model }
  }
  it('历史音色复制空白在调用前归一，空白 ID 使用默认，其他平台仍阻断', async () => {
    for (const voice of [
      { provider: ' minimax/api\n', voiceId: '\t copied-voice \u3000' },
      { provider: 'minimax/api', voiceId: '  ' },
    ]) {
      const f = fixture('')
      // 不先 parse，覆盖历史画布读取路径。
      f.ctx.params.voice = voice
      await speech.run(f.ctx)
      expect(f.submit).toHaveBeenCalledWith(
        'audio.speech',
        f.model,
        expect.objectContaining({ voice: voice.voiceId.trim() || undefined }),
      )
      expect(speechNode.params.parse(f.ctx.params).voice).toEqual({
        provider: voice.provider.trim(),
        voiceId: voice.voiceId.trim(),
      })
    }
    const other = fixture('')
    other.ctx.params.voice = { provider: ' other/provider ', voiceId: ' copied-voice ' }
    await expect(speech.run(other.ctx)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(other.submit).not.toHaveBeenCalled()
  })
  it('MiniMax 仅把官方情绪标签精确映射为 emotion，在 host.call 前完成', async () => {
    for (const [instruction, emotion] of [
      ['高兴', 'happy'],
      ['悲伤', 'sad'],
      ['愤怒', 'angry'],
      ['害怕', 'fearful'],
      ['厌恶', 'disgusted'],
      ['惊讶', 'surprised'],
      ['平静', 'calm'],
      ['sad', 'sad'],
    ]) {
      const f = fixture(instruction!)
      await speech.run(f.ctx)
      expect(f.submit).toHaveBeenCalledWith(
        'audio.speech',
        f.model,
        expect.objectContaining({ instruction: undefined, extra: { emotion } }),
      )
    }
    const override = fixture('悲伤', { emotion: 'angry' })
    await speech.run(override.ctx)
    expect(override.submit).toHaveBeenCalledWith(
      'audio.speech',
      override.model,
      expect.objectContaining({ extra: { emotion: 'angry' } }),
    )
  })
  it('任意语气不静默降级，即使已选 emotion 也先清楚阻断；支持自由语气时照传', async () => {
    for (const instruction of ['低声哭腔', '悲伤地笑', 'constructor']) {
      const f = fixture(instruction, { emotion: 'sad' })
      await expect(speech.run(f.ctx)).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.stringContaining('换用支持自由语气'),
      })
      expect(f.submit).not.toHaveBeenCalled()
    }
    const supported = fixture('低声哭腔', {}, true)
    await speech.run(supported.ctx)
    expect(supported.submit).toHaveBeenCalledWith(
      'audio.speech',
      supported.model,
      expect.objectContaining({ instruction: '低声哭腔' }),
    )
  })
})

describe('独立音频节点', () => {
  it('音效通过宿主能力调用，输出可入库音频', async () => {
    const submit = call({ assets: [audio] })
    const ctx = {
      params: sfxNode.params.parse({ model: 'mock:audio', prompt: '雷声', duration: 6 }),
      inputs: { prompt: [{ type: 'text', text: '远处，渐弱' }] },
      providers: { call: submit },
    } as unknown as Parameters<typeof sfx.run>[0]
    expect(await sfx.run(ctx)).toEqual({ audio: [{ type: 'audio', ...audio }] })
    expect(submit).toHaveBeenCalledWith('audio.sfx', 'mock:audio', {
      prompt: '雷声\n\n远处，渐弱',
      duration: 6,
    })
  })
  it('识别输出全文与秒级分句，只有分句时也能提供全文', async () => {
    const segments = [{ start: 0.2, end: 1.4, text: '你来了' }]
    const submit = call({ outputs: [{ type: 'json', value: { segments } }] })
    const ctx = {
      params: transcribeNode.params.parse({ model: 'mock:asr', language: 'zh' }),
      inputs: { audio: [{ type: 'audio', ...audio }] },
      providers: { call: submit },
    } as unknown as Parameters<typeof transcription.run>[0]
    expect(await transcription.run(ctx)).toEqual({
      text: [{ type: 'text', text: '你来了' }],
      segments: [{ type: 'json', value: { segments } }],
    })
    expect(submit).toHaveBeenCalledWith('audio.transcribe', 'mock:asr', {
      audio: { type: 'audio', ...audio },
      language: 'zh',
    })
  })
  it('无音频或无描述先阻断，不调用平台；无效识别时间戳不冒充有效字幕', async () => {
    const submit = call()
    await expect(
      sfx.run({
        params: sfxNode.params.parse({ model: 'mock:audio' }),
        inputs: {},
        providers: { call: submit },
      } as unknown as Parameters<typeof sfx.run>[0]),
    ).rejects.toThrow('描述为空')
    await expect(
      transcription.run({
        params: transcribeNode.params.parse({ model: 'mock:asr' }),
        inputs: {},
        providers: { call: submit },
      } as unknown as Parameters<typeof transcription.run>[0]),
    ).rejects.toThrow('一段音频')
    expect(submit).not.toHaveBeenCalled()
    const ctx = {
      params: transcribeNode.params.parse({ model: 'mock:asr' }),
      inputs: { audio: [{ type: 'audio', ...audio }] },
      providers: {
        call: call({
          outputs: [
            { type: 'text', text: '坏时间' },
            { type: 'json', value: { segments: [{ start: 2, end: 1, text: '坏时间' }] } },
          ],
        }),
      },
    } as unknown as ExecutorContext
    await expect(transcription.run(ctx as Parameters<typeof transcription.run>[0])).rejects.toThrow(
      '时间戳无效',
    )
  })
})
