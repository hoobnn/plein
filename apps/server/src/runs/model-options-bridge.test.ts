import { openaiProvider } from '@plein/providers'
import { describe, expect, it } from 'vite-plus/test'
import { modelOptionsProblem } from './model-options'

describe('桥接来的模型参数', () => {
  it('校验失败时报错仍带中文标题', () => {
    const spec = openaiProvider.models.find((m) => m.id === 'gpt-image-2.5-sunburst')
    expect(modelOptionsProblem(spec, { quality: 'bad', output_format: 'gif' })).toContain(
      '画质（quality）、输出格式（output_format）',
    )
    const chat = openaiProvider.models.find((m) => m.id === 'gpt-6.1-sol')
    expect(modelOptionsProblem(chat, { reasoning_effort: 'extreme' })).toContain(
      '思考强度（reasoning_effort）',
    )
  })
})
