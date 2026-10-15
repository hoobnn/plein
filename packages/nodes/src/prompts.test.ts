import { describe, expect, it } from 'vite-plus/test'
import { corePlugin } from './core'
import { corePrompts, firstPlaceholder, presetsFor, slashQuery } from './prompts'
import { shotPresets } from './shotPresets'

describe('/ 提示词预设', () => {
  it('按能力或节点类型筛选', () => {
    const image = presetsFor(corePrompts, { type: 'plein/image', capability: 'image.generate' })
    expect(image.map((p) => p.id)).toContain('plein/three-view')
    expect(image.map((p) => p.id)).not.toContain('plein/slow-push')
    // 分镜节点也是 text.chat，但剧本预设只给 LLM 节点
    const board = presetsFor(corePrompts, { type: 'plein/storyboard', capability: 'text.chat' })
    expect(board).toEqual([])
    const llm = presetsFor(corePrompts, { type: 'plein/llm', capability: 'text.chat' })
    expect(llm.map((p) => p.id)).toEqual(['plein/script'])
    expect(presetsFor([{ appliesTo: [] }], { type: 'x' })).toHaveLength(1)
  })

  it('只在行首触发，遇到空白结束', () => {
    expect(slashQuery('/三视', 3)).toEqual({ start: 0, query: '三视' })
    expect(slashQuery('雨夜\n/九', 5)).toEqual({ start: 3, query: '九' })
    expect(slashQuery('雨夜 /九', 5)).toBeNull()
    expect(slashQuery('/三视 图', 6)).toBeNull()
    expect(slashQuery('', 0)).toBeNull()
  })

  it('找第一个待填占位', () => {
    expect(firstPlaceholder('【角色】的三视图')).toEqual({ start: 0, end: 4 })
    expect(firstPlaceholder('镜头推近【主体】', 2)).toEqual({ start: 4, end: 8 })
    expect(firstPlaceholder('没有占位')).toBeNull()
  })

  it('清单声明与内置预设一致', () => {
    const all = [...corePrompts, ...shotPresets]
    expect(corePlugin.manifest.contributes.prompts).toEqual(all.map((p) => p.id))
    expect(corePlugin.prompts).toEqual(all)
  })
})
