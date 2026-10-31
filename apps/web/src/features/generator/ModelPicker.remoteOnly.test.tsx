// @vitest-environment happy-dom
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import type { NodeInfo } from '../../canvas/nodes'
import { ModelPicker } from './ModelPicker'

const catalog = (): Catalog => ({
  plugins: [],
  nodes: [],
  templates: [],
  prompts: [],
  elements: [],
  defaultModels: {},
  providers: [
    {
      id: 'acme/x',
      plugin: 'acme/p',
      title: '测试平台',
      enabled: true,
      configured: true,
      credentialCount: 1,
      settingsSchema: {},
      secrets: [],
      models: [
        { id: 'known', title: '内置对话', capabilities: ['text.chat'] },
        {
          id: 'brand-new',
          title: '远端新对话',
          capabilities: ['text.chat'],
          description: '参数为通用默认，以平台列表为准',
          remoteOnly: true,
        },
        {
          id: 'brand-new-video',
          title: '远端新视频',
          capabilities: ['video.generate'],
          description: '参数为通用默认，以平台列表为准',
          remoteOnly: true,
        },
      ],
    },
  ],
})

const node = (capability: string): NodeInfo => ({ capability }) as unknown as NodeInfo

async function open(capability: string) {
  const view = renderApp(
    <ModelPicker value="" node={node(capability)} catalog={catalog()} onChange={() => {}} />,
  )
  await view.user.click(screen.getByRole('button', { name: '模型' }))
  return view
}

describe('ModelPicker 的 remote-only 模型', () => {
  it('对话类 remote-only 进列表并带「新」徽标与通用默认提示', async () => {
    await open('text.chat')
    const chat = screen.getByRole('option', { name: /远端新对话/ })
    expect(chat.textContent).toContain('新')
    expect(chat.textContent).toContain('参数为通用默认')
    expect(screen.getByRole('option', { name: /内置对话/ })).toBeTruthy()
  })

  it('非对话类的 remote-only 只在设置里展示，不进生成器', async () => {
    const view = await open('video.generate')
    expect(screen.queryByRole('option', { name: /远端新视频/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /远端新对话/ })).toBeNull()
    view.unmount()
    const second = await open('image.generate')
    expect(second.container).toBeTruthy()
    expect(screen.queryByRole('option', { name: /远端新视频/ })).toBeNull()
  })
})
