import { describe, expect, it } from 'vite-plus/test'
import {
  createElement,
  duplicateElements,
  exportElements,
  groupShots,
  importElements,
  makeShotGroup,
  moveShot,
  shotGroupOf,
} from './index'
import { box, openDoc } from './testing'

describe('分镜组复制', () => {
  it.each(['duplicate', 'import'] as const)('%s 保留自定义镜头顺序和切分来源映射', (mode) => {
    const source = openDoc()
    const frame = createElement(source, box({ kind: 'frame' }))
    const left = createElement(source, box({ assetId: 'left', parentId: frame }))
    const right = createElement(source, box({ assetId: 'right', parentId: frame, x: 200 }))
    makeShotGroup(source, frame, { cols: 2, source: { elementId: left, rows: 1, cols: 2 } })
    moveShot(source, frame, right, 0)
    const original = shotGroupOf(source.get(frame))!
    const target = mode === 'duplicate' ? source : openDoc()
    target.undo.stopCapturing()
    const [copy] =
      mode === 'duplicate'
        ? duplicateElements(source, [frame])
        : importElements(target, JSON.parse(JSON.stringify(exportElements(source, [frame]))))
    const kids = target.children(copy!)
    const copiedLeft = kids.find((el) => el.assetId === 'left')!.id
    const copiedRight = kids.find((el) => el.assetId === 'right')!.id
    expect(groupShots(target, copy!).map((el) => el.assetId)).toEqual(['right', 'left'])
    expect(shotGroupOf(target.get(copy!))).toEqual({
      order: [copiedRight, copiedLeft],
      cols: 2,
      source: { elementId: copiedLeft, rows: 1, cols: 2 },
    })
    expect(shotGroupOf(source.get(frame))).toEqual(original)
    target.undo.undo()
    expect(target.has(copy!)).toBe(false)
    target.undo.redo()
    expect(groupShots(target, copy!).map((el) => el.assetId)).toEqual(['right', 'left'])
    if (target !== source) target.destroy()
    source.destroy()
  })
})
