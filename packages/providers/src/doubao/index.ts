import {
  type CapabilityInput,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type ProviderContext,
  type VoicePreset,
  type TranscriptSegment,
  ProviderError,
  type ProviderErrorCode,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { isJson, type Json, readText, redact, send } from '../shared/http'

const settings = z.object({
  voice: z.string().min(1).default('zh_female_vv_uranus_bigtts').meta({ title: '默认音色 ID' }),
  format: z.enum(['mp3', 'wav']).default('mp3').meta({ title: '音频格式' }),
  sampleRate: z.enum(['16000', '24000', '48000']).default('24000').meta({ title: '采样率' }),
})
type Context = ProviderContext<z.output<typeof settings>>
const secrets = ['VOLC_SPEECH_API_KEY', 'VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_KEY']
const host = 'https://openspeech.bytedance.com'

function object(value: unknown): Json {
  if (!isJson(value))
    throw new ProviderError('unavailable', '豆包语音返回无效 JSON 对象', { retryable: false })
  return value
}

function headers(ctx: Context, resource?: string): Record<string, string> {
  const result: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Request-Id': crypto.randomUUID(),
  }
  const key = ctx.secret('VOLC_SPEECH_API_KEY')
  if (key) result['X-Api-Key'] = key
  else {
    const app = ctx.secret('VOLC_SPEECH_APP_ID')
    const access = ctx.secret('VOLC_SPEECH_ACCESS_KEY')
    if (!app || !access) {
      throw new ProviderError('auth', '请配置 VOLC_SPEECH_API_KEY，或旧版 APP ID 与 Access Key')
    }
    result['X-Api-App-Key'] = app
    result['X-Api-Access-Key'] = access
  }
  if (resource) result['X-Api-Resource-Id'] = resource
  return result
}

function scrub(value: string, ctx: Context) {
  return redact(
    value,
    secrets.map((name) => ctx.secret(name)),
  )
}

function failure(status: number, code: unknown, message: unknown, ctx: Context): ProviderError {
  const detail = scrub(typeof message === 'string' ? message : '请求失败', ctx).slice(0, 500)
  let normalized: ProviderErrorCode = 'unknown'
  // 只匹配完整词：“sample_rate”“max tokens”这类参数错误不能被当成限流或鉴权
  if (
    status === 401 ||
    status === 403 ||
    /\bunauthori[sz]ed\b|\binvalid[ _-]?(?:token|api[ _-]?key|credential)|鉴权|权限/i.test(detail)
  ) {
    normalized = 'auth'
  } else if (status === 402 || /\bquota\b|\binsufficient balance\b|欠费|余额|额度/i.test(detail))
    normalized = 'quota'
  else if (
    status === 429 ||
    /\brate[ _-]?limit|\btoo many requests\b|\bconcurrency\b|limit exceeded|限流|并发/i.test(detail)
  )
    normalized = 'rate_limit'
  else if (/content.?policy|sensitive|违规|敏感/i.test(detail)) normalized = 'content_policy'
  else if (status === 408 || status === 504) normalized = 'timeout'
  else if (status >= 500 || String(code).startsWith('550')) normalized = 'unavailable'
  else if (status === 400 || String(code).startsWith('450')) normalized = 'invalid_input'
  return new ProviderError(
    normalized,
    `豆包语音 ${scrub(String(code ?? status), ctx)}: ${detail}`,
    { retryable: false },
  )
}

async function post(ctx: Context, path: string, body: Json, resource?: string, asr = false) {
  const requestHeaders = headers(ctx, resource)
  if (asr) requestHeaders['X-Api-Sequence'] = '-1'
  // 只有提交接口，一律不可重试；分块响应读完前断开同样算提交结果未知
  const messages = {
    cancelled: '豆包语音请求已取消',
    network: '豆包语音网络请求失败，提交结果未知',
    timeout: '豆包语音请求超时，提交结果未知',
  }
  const response = await send(
    ctx,
    `${host}${path}`,
    { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) },
    messages,
  )
  const raw = await readText(ctx, response, 'POST', messages)
  const status = response.headers.get('X-Api-Status-Code')
  if (!response.ok || (status && status !== '20000000' && !(asr && status === '20000003'))) {
    let detail: Json = {}
    try {
      const parsed = object(JSON.parse(raw))
      detail = parsed.header ? object(parsed.header) : parsed
    } catch {
      // HTTP headers still carry useful errors when the response is not JSON.
    }
    throw failure(
      response.status,
      detail.code ?? status,
      detail.message ?? response.headers.get('X-Api-Message'),
      ctx,
    )
  }
  return { raw, silent: status === '20000003' }
}

/** HTTP Chunked may contain newline-delimited or directly adjacent JSON objects. */
function incomplete(message: string) {
  return new ProviderError('unavailable', message, { retryable: false })
}

function events(raw: string): Json[] {
  const result: Json[] = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (start < 0) {
      if (/\s/.test(c!)) continue
      if (c !== '{') throw incomplete('豆包语音返回无效音频流')
      start = i
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        try {
          result.push(object(JSON.parse(raw.slice(start, i + 1))))
        } catch {
          throw incomplete('豆包语音返回无效音频流')
        }
        start = -1
      }
    }
  }
  if (start >= 0 || result.length === 0) throw incomplete('豆包语音音频流不完整')
  return result
}

function audioResult(raw: string, field: 'data' | 'audio', ctx: Context, requireEnd = false) {
  const packets = events(raw)
  const chunks: Buffer[] = []
  let ended = false
  for (const packet of packets) {
    const code = packet.code
    if (code !== undefined && ![0, 20000000].includes(Number(code))) {
      throw failure(200, code, packet.message, ctx)
    }
    if (Number(code) === 20000000) ended = true
    const data = packet[field]
    if (data === undefined || data === null || data === '') continue
    if (
      typeof data !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw incomplete('豆包语音返回无效 Base64 音频')
    }
    chunks.push(Buffer.from(data, 'base64'))
  }
  if (requireEnd && !ended) throw incomplete('豆包语音未返回合成完成标记')
  let data = Buffer.concat(chunks)
  if (data.length === 0) throw incomplete('豆包语音未返回内嵌音频')
  if (requireEnd && ctx.settings.format === 'wav')
    data = pcmWav(data, Number(ctx.settings.sampleRate))
  return {
    state: 'succeeded' as const,
    outputs: [
      {
        type: 'file' as const,
        kind: 'audio' as const,
        mime: ctx.settings.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        name: `doubao.${ctx.settings.format}`,
        data: new Uint8Array(data),
      },
    ],
  }
}

/** TTS PCM is signed 16-bit little endian, mono; create a single RIFF container. */
function pcmWav(pcm: Buffer, sampleRate: number) {
  if (pcm.length % 2 !== 0) throw incomplete('豆包语音 PCM 音频缺少完整采样')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function text(value: unknown, name: string, max = 3000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ProviderError('invalid_input', `${name} 必须是 1 至 ${max} 字的文本`)
  }
  return value
}

/**
 * 语音合成 2.0 里适合短剧角色的音色（官方音色列表：https://docs.volcengine.com/docs/6561/1257544），
 * 同性别同年龄段按顺序轮着分给不同角色
 */
const TTS_VOICES: VoicePreset[] = [
  { id: 'zh_female_vv_uranus_bigtts', title: 'Vivi 2.0', gender: 'female' },
  { id: 'zh_female_xiaohe_uranus_bigtts', title: '小何 2.0', gender: 'female' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', title: '邻家女孩 2.0', gender: 'female' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', title: '高冷御姐 2.0', gender: 'female' },
  { id: 'zh_female_wenroushunv_uranus_bigtts', title: '温柔淑女 2.0', gender: 'female' },
  {
    id: 'zh_female_zhixingnv_uranus_bigtts',
    title: '知性女声 2.0',
    gender: 'female',
    age: 'mature',
  },
  {
    id: 'zh_female_wenroumama_uranus_bigtts',
    title: '温柔妈妈 2.0',
    gender: 'female',
    age: 'mature',
  },
  { id: 'zh_female_popo_uranus_bigtts', title: '婆婆 2.0', gender: 'female', age: 'mature' },
  { id: 'zh_male_m191_uranus_bigtts', title: '云舟 2.0', gender: 'male' },
  { id: 'zh_male_taocheng_uranus_bigtts', title: '小天 2.0', gender: 'male' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', title: '少年梓辛 2.0', gender: 'male' },
  { id: 'zh_male_aojiaobazong_uranus_bigtts', title: '傲娇霸总 2.0', gender: 'male' },
  { id: 'zh_male_gaolengchenwen_uranus_bigtts', title: '高冷沉稳 2.0', gender: 'male' },
  { id: 'zh_male_baqiqingshu_uranus_bigtts', title: '霸气青叔 2.0', gender: 'male', age: 'mature' },
  {
    id: 'zh_male_yuanboxiaoshu_uranus_bigtts',
    title: '渊博小叔 2.0',
    gender: 'male',
    age: 'mature',
  },
  {
    id: 'zh_male_xuanyijieshuo_uranus_bigtts',
    title: '悬疑解说 2.0',
    gender: 'male',
    age: 'mature',
  },
]

export const doubaoProvider = defineProvider({
  testScope: 'configuration',
  id: 'doubao/speech',
  title: '豆包语音',
  description: '语音合成、Seed Audio 音乐与音效、录音文件极速识别；测试仅检查本地配置',
  docsUrl:
    'https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh',
  settings,
  secrets: secrets.map((name) => ({ name, title: name, required: false })),
  credentialAlternatives: [
    ['VOLC_SPEECH_API_KEY'],
    ['VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_KEY'],
  ],
  models: [
    {
      id: 'seed-tts-2.0',
      title: '豆包语音合成 2.0',
      capabilities: ['audio.speech'],
      limits: { speed: { min: 0.5, max: 2 } },
      voices: TTS_VOICES,
    },
    {
      id: 'seed-icl-2.0',
      title: '豆包声音复刻 2.0（已有音色）',
      capabilities: ['audio.speech'],
      limits: { speed: { min: 0.5, max: 2 } },
    },
    {
      id: 'seed-audio-1.0',
      title: 'Seed Audio 1.0',
      capabilities: ['audio.music', 'audio.sfx'],
      limits: { duration: { min: 1, max: 120 } },
    },
    { id: 'bigmodel', title: '录音文件识别极速版', capabilities: ['audio.transcribe'] },
  ],
  async test(ctx) {
    headers(ctx)
    ctx.log('本地配置检查通过；未调用计费接口，尚未验证远端密钥、模型权限或网络')
  },
  async submit(req, ctx) {
    const supported = doubaoProvider.models.find((model) => model.id === req.model)
    if (!supported?.capabilities.includes(req.capability)) {
      throw new ProviderError('invalid_input', '豆包语音模型不支持该能力')
    }
    headers(ctx)
    if (req.capability === 'audio.speech') {
      const input = req.input as CapabilityInput<'audio.speech'>
      const content = text(input.text, '合成文本')
      const voice = input.voice ?? ctx.settings.voice
      if (req.model === 'seed-icl-2.0' && !voice.startsWith('S_')) {
        throw new ProviderError('invalid_input', '声音复刻模型需要已创建的 S_ 音色 ID')
      }
      if (req.model === 'seed-tts-2.0' && voice.startsWith('S_')) {
        throw new ProviderError('invalid_input', '复刻音色请选择 seed-icl-2.0')
      }
      const speed = input.speed ?? 1
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
        throw new ProviderError('invalid_input', '语速须在 0.5 至 2 之间')
      const { raw } = await post(
        ctx,
        '/api/v3/tts/unidirectional',
        {
          req_params: {
            text: content,
            speaker: text(voice, '音色 ID'),
            audio_params: {
              format: ctx.settings.format === 'wav' ? 'pcm' : ctx.settings.format,
              sample_rate: Number(ctx.settings.sampleRate),
              speech_rate: Math.round((speed - 1) * 100),
            },
            additions: JSON.stringify(
              input.instruction ? { context_texts: [input.instruction] } : {},
            ),
          },
        },
        req.model,
      )
      return audioResult(raw, 'data', ctx, true)
    }
    if (req.capability === 'audio.music' || req.capability === 'audio.sfx') {
      const input = req.input as CapabilityInput<'audio.music'>
      if (
        input.duration !== undefined &&
        (!Number.isFinite(input.duration) || input.duration <= 0 || input.duration > 120)
      ) {
        throw new ProviderError('invalid_input', '音频时长须大于 0 且不超过 120 秒')
      }
      const prompt = text(input.prompt, '音频描述')
      const kind =
        req.capability === 'audio.music'
          ? '仅生成音乐，不要人声对白。'
          : '仅生成音效，不要音乐或人声对白。'
      const { raw } = await post(ctx, '/api/v3/tts/create', {
        model: req.model,
        text_prompt: text(
          `${kind}${input.duration ? `目标时长 ${input.duration} 秒。` : ''}${prompt}`,
          '完整音频描述',
        ),
        audio_config: { format: ctx.settings.format, sample_rate: Number(ctx.settings.sampleRate) },
      })
      return audioResult(raw, 'audio', ctx)
    }
    if (req.capability === 'audio.transcribe') {
      const input = req.input as CapabilityInput<'audio.transcribe'>
      const asset = await ctx.files.read(input.audio)
      if (!asset.data.length || asset.data.length > 100 * 1024 * 1024)
        throw new ProviderError('invalid_input', '识别音频须为 1 字节至 100 MB')
      const format = (
        {
          'audio/mpeg': 'mp3',
          'audio/mp3': 'mp3',
          'audio/wav': 'wav',
          'audio/x-wav': 'wav',
          'audio/ogg': 'ogg',
          'audio/flac': 'flac',
          'audio/mp4': 'm4a',
        } as Record<string, string>
      )[asset.mime]
      if (!format)
        throw new ProviderError('invalid_input', '极速识别支持 MP3、WAV、Ogg Opus、FLAC、M4A 音频')
      const { raw, silent } = await post(
        ctx,
        '/api/v3/auc/bigmodel/recognize/flash',
        {
          audio: {
            data: Buffer.from(asset.data).toString('base64'),
            format,
            ...(format === 'ogg' ? { codec: 'opus' } : {}),
            ...(input.language ? { language: input.language } : {}),
          },
          // show_utterances：返回分句和时间戳，序列导出用它校准字幕
          request: {
            model_name: 'bigmodel',
            enable_itn: true,
            enable_punc: true,
            show_utterances: true,
          },
        },
        'volc.bigasr.auc_turbo',
        true,
      )
      if (silent) return { state: 'succeeded', outputs: [{ type: 'text', text: '' }] }
      const packet = events(raw)[0]!
      if (packet.code !== undefined && ![0, 20000000].includes(Number(packet.code))) {
        throw failure(200, packet.code, packet.message, ctx)
      }
      const result = object(packet.result)
      if (typeof result.text !== 'string')
        throw new ProviderError('unavailable', '豆包语音返回无效识别文本')
      // 分句时间是毫秒，按 SDK 约定换成秒
      const segments: TranscriptSegment[] = (
        Array.isArray(result.utterances) ? result.utterances : []
      )
        .map(object)
        .filter(
          (u) =>
            typeof u.text === 'string' &&
            typeof u.start_time === 'number' &&
            typeof u.end_time === 'number' &&
            u.end_time > u.start_time,
        )
        .map((u) => ({
          start: (u.start_time as number) / 1000,
          end: (u.end_time as number) / 1000,
          text: (u.text as string).trim(),
        }))
      return {
        state: 'succeeded',
        outputs: [
          { type: 'text', text: result.text },
          ...(segments.length ? [{ type: 'json' as const, value: { segments } }] : []),
        ],
      }
    }
    throw new ProviderError('invalid_input', '豆包语音不支持该能力')
  },
})

export const doubaoPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'doubao/speech',
      version: '0.1.0',
      name: '豆包语音',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['doubao/speech'] },
      permissions: { network: ['openspeech.bytedance.com'], secrets, assets: 'read' },
    },
  }),
  { providers: [doubaoProvider] },
)
