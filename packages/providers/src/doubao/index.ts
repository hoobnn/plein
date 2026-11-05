import {
  CLONE_SAMPLE,
  doubaoAdapter,
  headers,
  speechSettings,
  TTS_VOICES,
} from '@modelbay/doubao-speech'
import { definePlugin, defineServerPlugin, PLUGIN_API_VERSION } from '@plein/plugin-sdk'
import { adapterModels, adapterToProvider, toAdapterContext } from '../bridge'

export { speechSettings, TTS_VOICES }

/** 请求构造、流式音频解码、复刻与设计、错误归类都在 modelbay；这里只留宿主侧的设置、密钥与表单元数据。 */
const adapter = doubaoAdapter
const secrets = ['VOLC_SPEECH_API_KEY', 'VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_KEY']

/** 设置页显示的人读标题；变量名只用来存取密钥 */
const SECRET_TITLES: Record<string, string> = {
  VOLC_SPEECH_API_KEY: 'API Key',
  VOLC_SPEECH_APP_ID: 'APP ID（旧版鉴权）',
  VOLC_SPEECH_ACCESS_KEY: 'Access Key（旧版鉴权）',
}

const bridged = adapterToProvider(adapter, {
  testScope: 'configuration',
  id: 'doubao/speech',
  title: '豆包语音',
  description: '语音合成、Seed Audio 音乐与音效、录音文件极速识别；测试仅检查本地配置',
  docsUrl:
    'https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh',
  settings: speechSettings,
  secrets: secrets.map((name) => ({
    name,
    title: SECRET_TITLES[name] ?? name,
    required: false,
  })),
  credentialAlternatives: [
    ['VOLC_SPEECH_API_KEY'],
    ['VOLC_SPEECH_APP_ID', 'VOLC_SPEECH_ACCESS_KEY'],
  ],
  // seed-tts-1.0 只服务历史音色，不进 plein 的模型列表
  models: adapterModels(adapter, 'doubao-speech').filter((spec) => spec.id !== 'seed-tts-1.0'),
  async test(ctx) {
    headers(toAdapterContext(ctx))
    ctx.log('本地配置检查通过；未调用计费接口，尚未验证远端密钥、模型权限或网络')
  },
  // 按声音复刻 V3 接口对接（/api/v3/tts/voice_clone、/api/v3/tts/get_voice），尚未真机验证
  voiceClone: {
    voiceId: 'slot',
    customId: true,
    hint: '先在火山引擎控制台开通声音复刻，填分配的 S_ 音色 ID。样本建议 14–30 秒以改善效果，短音频可提交，由平台判定；单人清晰、无背景音乐，WAV / MP3 / OGG / M4A / AAC，10 MB 以内；预付费槽位消耗训练次数；后付费自定义音色首次正式合成会转正计费，转正后不可再复刻，未合成的音色 7 天后删除',
    sample: CLONE_SAMPLE,
    clone: (input, ctx) => adapter.voiceClone.clone(input, toAdapterContext(ctx)),
    status: (voiceId, ctx) => adapter.voiceClone.status(voiceId, toAdapterContext(ctx)),
  },
  voiceDesign: {
    voiceId: 'slot',
    hint: '使用控制台购买的 S_ 音色槽位；文字描述或角色图片生成音色，图片优先。会消耗该槽位的设计次数，重复使用同一槽位会覆盖原音色。',
    maxPromptLength: 200,
    maxPreviewLength: 300,
    image: true,
    design: (input, ctx) => adapter.voiceDesign.design(input, toAdapterContext(ctx)),
  },
})

/** 桥接把音频换成 Node Buffer；豆包一直交付纯 Uint8Array（合同测试按此断言），这里还原。 */
function plainBytes<R>(result: R): R {
  const outputs = (result as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return result
  return {
    ...result,
    outputs: outputs.map((output: { type?: string; data?: Uint8Array }) =>
      output.type === 'file' && output.data
        ? { ...output, data: new Uint8Array(output.data) }
        : output,
    ),
  }
}

export const doubaoProvider: typeof bridged = {
  ...bridged,
  submit: async (request, ctx) => plainBytes(await bridged.submit(request, ctx)),
}

export const doubaoPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'doubao/speech',
      version: '0.1.0',
      name: '豆包语音',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['doubao/speech'] },
      permissions: {
        network: ['openspeech.bytedance.com', '*.bytespeech.com'],
        secrets,
        assets: 'read',
      },
    },
  }),
  { providers: [doubaoProvider] },
)
