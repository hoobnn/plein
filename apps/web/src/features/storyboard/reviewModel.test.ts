import {
  addResults,
  adoptResult,
  createElement,
  creativeReviewTarget,
  recordCreativeReview,
  type CanvasElement,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import {
  continuityWindow,
  nextPendingShot,
  reviewNodesForShot,
  shotReviewStatus,
} from './reviewModel'

describe('逐镜创作验收与切点范围', () => {
  it('运行成功不代表通过，同素材新候选不继承人工结论；下一待审按镜头顺序循环', () => {
    const doc = openDoc()
    const image = createElement(doc, node({ params: { source: { role: 'image' } } }))
    const video = createElement(doc, node({ params: { source: { role: 'video' } } }))
    for (const id of [image, video])
      addResults(doc, id, [
        {
          id: `r_${id}`,
          port: 'out',
          runId: 'run1',
          at: 1,
          value: { type: id === image ? 'image' : 'video', assetId: id },
        },
      ])
    const nodes = () => [doc.get(image)!, doc.get(video)!]
    const shots = ['a', 'b', 'c'].map((id, no) => Shot.parse({ id, no }))
    expect(shotReviewStatus(nodes(), shots[0])).toBe('pending')
    for (const id of [image, video])
      recordCreativeReview(doc, id, {
        target: creativeReviewTarget(doc.get(id))!,
        status: 'usable',
      })
    expect(shotReviewStatus(nodes(), shots[0])).toBe('usable')
    expect(shotReviewStatus([doc.get(image)!], shots[0])).toBe('pending')
    recordCreativeReview(doc, video, {
      target: creativeReviewTarget(doc.get(video))!,
      status: 'changes',
      note: '动作方向不接',
    })
    expect(shotReviewStatus(nodes())).toBe('changes')
    addResults(doc, video, [
      {
        id: 'new-candidate',
        port: 'out',
        runId: 'run2',
        at: 2,
        value: { type: 'video', assetId: video },
      },
    ])
    expect(shotReviewStatus(nodes())).toBe('pending')
    const groups = new Map<string, CanvasElement[]>([['a', nodes()]])
    expect(nextPendingShot(shots, groups)?.id).toBe('a')
    expect(nextPendingShot(shots, groups, 'a')?.id).toBe('b')
    expect(nextPendingShot(shots, groups, 'c')?.id).toBe('a')
    expect(nextPendingShot([], groups)).toBeUndefined()
    adoptResult(doc, video, `r_${video}`)
    for (const id of [image, video])
      recordCreativeReview(doc, id, {
        target: creativeReviewTarget(doc.get(id))!,
        status: 'usable',
      })
    expect(nextPendingShot([shots[0]!], new Map([['a', nodes()]]))).toBeUndefined()
    doc.destroy()
  })

  it('已删的台词和清空音效不留在当前验收待办，当前缺配音仍待审', () => {
    const doc = openDoc()
    const speech = (id: string) =>
      doc.get(
        createElement(
          doc,
          node({ params: { text: id, source: { role: 'speech', dialogueId: id } } }),
        ),
      )!
    const current = speech('line-current'),
      removed = speech('line-removed')
    const sfx = doc.get(createElement(doc, node({ params: { source: { role: 'sfx' } } })))!
    const shot = Shot.parse({
      id: 'a',
      no: 1,
      dialogue: [{ id: 'line-current', character: '演员', line: '当前台词' }],
    })
    expect(reviewNodesForShot(shot, [current, removed, sfx]).map((node) => node.id)).toEqual([
      current.id,
    ])
    expect(shotReviewStatus([], shot)).toBe('pending')
    doc.destroy()
  })

  it('切点区间按实际视频时长收窄，拒绝未知、无穷与非法时长', () => {
    expect(continuityWindow(8.45, 'before')?.start).toBeCloseTo(7.45)
    expect(continuityWindow(8.45, 'before')?.end).toBe(8.45)
    expect(continuityWindow(8.45, 'after')).toEqual({ start: 0, end: 1 })
    expect(continuityWindow(0.4, 'before')).toEqual({ start: 0, end: 0.4 })
    expect(continuityWindow(0.4, 'after')).toEqual({ start: 0, end: 0.4 })
    for (const value of [NaN, Infinity, -1, 0])
      expect(continuityWindow(value, 'before')).toBeUndefined()
  })
})
