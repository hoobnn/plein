import { describe, it, expect } from 'vite-plus/test'
import { findMentions } from './mentions'
import { sceneViewsOf, sceneViewProblem } from './sceneViews'
import { renamed } from './profile'
const A = 'a'.repeat(64)
const view = { id: 'door', name: '门口', aliases: [], description: '从门口望向黑板', images: [A] }
describe('场景命名视角', () => {
  it('最长匹配视角并通过旧名保持同一稳定身份', () => {
    const changed = renamed(view, '门口正拍')
    const target = { id: 'scene', name: '教室', sceneViews: [changed] }
    for (const name of ['门口', '门口正拍']) {
      const [m] = findMentions(`@教室/${name} 人物走入`, [target])
      expect(m?.sceneView?.id).toBe('door')
      expect(m?.end).toBe(`@教室/${name}`.length)
    }
  })
  it('视角后可紧接另一处引用，仍按同一提及边界解析', () => {
    const matches = findMentions('@教室/门口@林夏', [
      { id: 'scene', name: '教室', sceneViews: [view] },
      { id: 'hero', name: '林夏' },
    ])
    expect(matches.map((m) => m.id)).toEqual(['scene', 'hero'])
    expect(matches[0]?.sceneView?.id).toBe('door')
    expect(matches[0]?.sceneViewMiss).toBeUndefined()
    expect(matches[0]?.end).toBe('@教室/门口'.length)
  })
  it('删除视角后保留明确失效信息，旧卡不受影响', () => {
    expect(
      findMentions('@教室/门口', [{ id: 'scene', name: '教室', sceneViews: [] }])[0]?.sceneViewMiss,
    ).toBe('门口')
    expect(findMentions('@教室', [{ id: 'scene', name: '教室' }])[0]?.id).toBe('scene')
    expect(sceneViewsOf(undefined)).toEqual([])
    expect(sceneViewProblem([], 'stairs')).toBeUndefined()
    expect(
      findMentions('@教室/门口未知', [{ id: 'scene', name: '教室', sceneViews: [view] }])[0]
        ?.sceneViewMiss,
    ).toBe('门口未知')
    expect(sceneViewProblem([view], '门口')).toBeDefined()
  })
  it('视角名必须立即终止，后文的空格或标点不能让未知后缀变成有效视角', () => {
    for (const text of ['@教室/门口未知 学生走入', '@教室/门口未知，学生走入']) {
      const [mention] = findMentions(text, [{ id: 'scene', name: '教室', sceneViews: [view] }])
      expect(mention?.sceneView).toBeUndefined()
      expect(mention?.sceneViewMiss).toBe('门口未知')
    }
  })
})
