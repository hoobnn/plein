// @vitest-environment happy-dom
import type { Catalog } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import type { NodeInfo } from '../../canvas/nodes'
import { renderApp, screen, within } from '../../testing/render'
import { ModelPicker } from './ModelPicker'

const catalog: Catalog = {
  plugins: [],
  nodes: [],
  templates: [],
  prompts: [],
  elements: [],
  defaultModels: { 'image.generate': 'test/platform:current' },
  providers: [
    {
      id: 'test/platform',
      plugin: 'test/plugin',
      title: '测试平台',
      enabled: true,
      configured: true,
      credentialCount: 1,
      settingsSchema: {},
      secrets: [],
      models: [
        { id: 'current', title: '当前模型', capabilities: ['image.generate'] },
        {
          id: 'legacy',
          title: '旧模型',
          description: '官方已停止新购，仅供旧画布引用',
          deprecated: true,
          capabilities: ['image.generate'],
        },
      ],
    },
  ],
}

it('弃用模型在选项和当前按钮上显示弱化标签及模型说明', async () => {
  const description = '官方已停止新购，仅供旧画布引用'
  const { user } = renderApp(
    <ModelPicker
      value="test/platform:legacy"
      node={{ capability: 'image.generate' } as NodeInfo}
      catalog={catalog}
      onChange={() => {}}
    />,
  )
  const trigger = screen.getByRole('button', { name: '模型' })
  const currentTag = within(trigger).getByText('已弃用')
  expect(currentTag.className).toContain('ui-tag')
  expect(currentTag.className).toContain('text-ink-subtle')
  expect(currentTag.title).toBe(description)
  expect(trigger.title).toBe(description)

  await user.click(trigger)
  const deprecated = await screen.findByRole('option', { name: /旧模型/ })
  expect(within(deprecated).getByText('已弃用').title).toBe(description)
  expect(deprecated.title).toBe(description)
  expect(deprecated.textContent).toContain(description)
  expect(screen.getByRole('option', { name: /当前模型/ }).textContent).not.toContain('已弃用')
})
