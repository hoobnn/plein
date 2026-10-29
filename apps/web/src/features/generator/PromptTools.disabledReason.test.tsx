// @vitest-environment happy-dom
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import { PromptTools } from './PromptTools'

const catalog = (withChat: boolean): Catalog =>
  ({
    providers: withChat
      ? [
          {
            id: 'p/chat',
            plugin: 'p',
            title: '对话平台',
            enabled: true,
            configured: true,
            credentialCount: 1,
            settingsSchema: {},
            secrets: [],
            models: [{ id: 'chat', title: '对话', capabilities: ['text.chat'] }],
          },
        ]
      : [],
    nodes: [],
    templates: [],
    prompts: [],
    elements: [],
    plugins: [],
    defaultModels: {},
  }) as unknown as Catalog

const node = {
  id: 'n1',
  title: '生成图片',
  capability: 'image.generate',
  fields: [],
} as never

function render(text: string, withChat: boolean) {
  renderApp(
    <PromptTools
      engine={{ doc: {} } as never}
      elId="n1"
      promptKey="prompt"
      text={text}
      node={node}
      catalog={catalog(withChat)}
    />,
  )
}

const optimize = () => screen.getByRole('button', { name: '优化提示词' })
const translate = () => screen.getByRole('button', { name: '翻译提示词' })

describe('提示词工具的禁用原因', () => {
  it('没有对话模型时说明去哪儿启用', () => {
    render('一只猫', false)
    expect(optimize().getAttribute('title')).toContain('没有可用的对话模型')
    expect(translate().getAttribute('title')).toContain('没有可用的对话模型')
  })

  it('提示词为空时说明要先写提示词', () => {
    render('  ', true)
    expect(optimize().getAttribute('title')).toBe('先写点提示词，才能优化或翻译')
    expect(translate().getAttribute('title')).toBe('先写点提示词，才能优化或翻译')
  })

  it('一切就绪时说明这个按钮做什么', () => {
    render('一只猫', true)
    expect(optimize().getAttribute('title')).toBe('优化提示词：先查看建议再采用')
    expect(translate().getAttribute('title')).toBe('翻译提示词：先查看建议再采用')
  })
})
