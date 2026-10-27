import type { Catalog, Voice } from '@plein/protocol'

export const voiceCatalog = {
  plugins: [],
  nodes: [],
  defaultModels: {},
  templates: [],
  prompts: [],
  elements: [],
  providers: [
    {
      id: 'plein/mock',
      title: '模拟平台',
      enabled: true,
      configured: true,
      models: [
        {
          id: 'audio',
          title: 'Mock 音频',
          capabilities: ['audio.speech'],
          voices: [{ id: 'mock-female', title: 'Mock 女声', gender: 'female' }],
        },
      ],
      voiceDesign: { voiceId: 'generated', maxPromptLength: 2000, maxPreviewLength: 500 },
      voiceClone: { voiceId: 'generated' },
    },
    {
      id: 'doubao/speech',
      title: '豆包语音',
      enabled: true,
      configured: true,
      models: [],
      voiceDesign: { voiceId: 'slot', image: true, maxPromptLength: 200, maxPreviewLength: 300 },
      voiceClone: { voiceId: 'slot', customId: true, hint: '短音频可提交' },
    },
    {
      id: 'minimax/api',
      title: 'MiniMax',
      enabled: true,
      configured: true,
      models: [],
      voiceDesign: { voiceId: 'generated', maxPromptLength: 2000, maxPreviewLength: 500 },
      voiceClone: { voiceId: 'generated', promptSample: true },
    },
  ],
} as unknown as Catalog

export const designedVoice = {
  id: 'voice',
  provider: 'plein/mock',
  voiceId: 'designed',
  name: '测试音色',
  source: 'design',
  status: 'ready',
  sampleAssetId: null,
  previewAssetId: 'preview',
  gender: null,
  age: null,
  message: null,
  createdAt: 1,
  updatedAt: 1,
} as Voice
