import { describe, expect, it } from 'vite-plus/test'
import { arkPlanProvider, arkProvider } from './index'

describe('方舟套餐目录', () => {
  it('文档入口是套餐概览页，按量渠道仍是模型列表页', () => {
    expect(arkPlanProvider.docsUrl).toBe(
      'https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh',
    )
    expect(arkProvider.docsUrl).toBe('https://docs.volcengine.com/docs/ark/model-list?lang=zh')
  })

  it('按量对话模型的顺序与原目录一致，第一个是 doubao-seed-2-1-pro-260628', () => {
    const chat = arkProvider.models.filter((m) => m.capabilities.includes('text.chat'))
    expect(chat.map((m) => m.id)).toEqual([
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-1-pro-260915',
      'doubao-seed-2-1-lite-260915',
      'doubao-seed-2-1-turbo-260628',
      'doubao-seed-evolving',
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
    expect(find('minimax-m3')?.deprecated).toBe(true)
    expect(find('kimi-k2.7-code')?.deprecated).toBe(true)
  })
})
