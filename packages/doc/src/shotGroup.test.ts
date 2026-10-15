import { describe, expect, it } from 'vite-plus/test'
import {
  clearShotGroup,
  createElement,
  deleteElements,
  groupElements,
  groupShots,
  layoutShotGroup,
  makeShotGroup,
  moveShot,
  SHOT_GAP,
  SHOT_PAD,
  shotGroupOf,
} from './index'
import { openDoc as open } from './testing'

function setup() {
  const doc = open()
  const img = (name: string, x: number, y: number, w = 100, h = 60) =>
    createElement(doc, { kind: 'image', assetId: `a-${name}`, name, x, y, w, h })
  // 两行：b a / c（a 在右）
  const a = img('a', 200, 0)
  const b = img('b', 0, 10)
  const c = img('c', 0, 200, 80, 80)
  const note = createElement(doc, { kind: 'markdown', text: '说明', x: 400, y: 0, w: 80, h: 20 })
  const frame = groupElements(doc, [a, b, c, note])!
  return { doc, frame, a, b, c }
}

describe('分镜组', () => {
  it('按阅读顺序编号，只算图片', () => {
    const { doc, frame, a, b, c } = setup()
    const g = makeShotGroup(doc, frame)
    expect(g?.order).toEqual([b, a, c])
    expect(shotGroupOf(doc.get(frame))?.order).toEqual([b, a, c])
  })

  it('调顺序；新放进来的接在后面；删掉的不再出现', () => {
    const { doc, frame, a, b, c } = setup()
    makeShotGroup(doc, frame)
    moveShot(doc, frame, c, 0)
    expect(groupShots(doc, frame).map((e) => e.id)).toEqual([c, b, a])
    const d = createElement(doc, {
      kind: 'image',
      assetId: 'a-d',
      parentId: frame,
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    deleteElements(doc, [b])
    expect(groupShots(doc, frame).map((e) => e.id)).toEqual([c, a, d])
  })

  it('排版：按格子排开，Frame 收到刚好包住，不改图片大小', () => {
    const { doc, frame, a, b, c } = setup()
    makeShotGroup(doc, frame)
    expect(layoutShotGroup(doc, frame, 2)).toBe(2)
    const cell = { w: 100, h: 80 }
    expect(doc.get(b)).toMatchObject({ x: SHOT_PAD, y: SHOT_PAD + 10, w: 100, h: 60 })
    expect(doc.get(a)).toMatchObject({ x: SHOT_PAD + cell.w + SHOT_GAP })
    expect(doc.get(c)).toMatchObject({ x: SHOT_PAD + 10, y: SHOT_PAD + cell.h + SHOT_GAP })
    expect(doc.get(frame)).toMatchObject({
      w: SHOT_PAD * 2 + cell.w * 2 + SHOT_GAP,
      h: SHOT_PAD * 2 + cell.h * 2 + SHOT_GAP,
    })
    expect(shotGroupOf(doc.get(frame))?.cols).toBe(2)
  })

  it('取消分镜组只去掉编号，图片都在', () => {
    const { doc, frame, a } = setup()
    makeShotGroup(doc, frame)
    clearShotGroup(doc, frame)
    expect(shotGroupOf(doc.get(frame))).toBeNull()
    expect(doc.get(a)).toBeDefined()
  })
})
