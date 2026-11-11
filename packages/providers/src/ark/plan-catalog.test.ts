import { describe, expect, it } from 'vite-plus/test'
import { arkPlanProvider, arkProvider } from './index'

describe('方舟套餐目录', () => {
  it('文档入口是套餐概览页，按量渠道直达创建 API Key 的页面', () => {
    expect(arkPlanProvider.docsUrl).toBe(
      'https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh',
    )
    expect(arkProvider.docsUrl).toBe('https://ark.volcengine.com/region:cn-beijing/apiKey')
  })

  it('按量对话模型的顺序与原目录一致，第一个是 doubao-seed-2-1-pro-260628', () => {
    const chat = arkProvider.models.filter((m) => m.capabilities.includes('text.chat'))
    expect(chat.map((m) => m.id)).toEqual([
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-1-pro-260915',
      'doubao-seed-2-1-lite-260915',
      'doubao-seed-2-1-turbo-260628',
      'doubao-seed-evolving',
      // modelbay 0.5.0 起第三方文本模型开放按量渠道，按量 ID 带日期后缀
      'deepseek-v4-flash-ga-260731',
      'deepseek-v4-pro-ga-260813',
      'deepseek-v4-1-flash-261017',
      'deepseek-v4-1-flash-economy-261017',
      'glm-5-3-flash-260828',
      'kimi-k3-1-pro-261024',
      'custom-chat',
    ])
  })

  it('套餐 custom-chat 与 doubao-seed-evolving 沿用原目录写法', () => {
    const find = (id: string) => arkPlanProvider.models.find((m) => m.id === id)
    expect(find('custom-chat')).toMatchObject({
      title: '自定义套餐对话模型',
      agentOnly: true,
      features: ['tools', 'structured'],
    })
    expect(find('doubao-seed-evolving')).toMatchObject({
      title: 'doubao-seed-evolving',
      description: 'Agent Plan 套餐文本模型，仅用于内置 Agent；可用性取决于套餐档位',
      agentOnly: true,
    })
    // 官方 Agent Plan 与方舟模型列表里已没有这两个模型，modelbay 删除了声明（2026-11-05 核对）
    expect(find('minimax-m3')).toBeUndefined()
    expect(find('kimi-k2.7-code')).toBeUndefined()
  })
})
