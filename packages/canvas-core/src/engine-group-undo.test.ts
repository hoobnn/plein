import { createElement, type PleinDoc } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { initEngine } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup(grouped: boolean) {
  const doc = openDoc()
  const first = createElement(doc, node({ x: 400, y: 200 }))
  const second = createElement(doc, node({ x: 800, y: 200 }))
  doc.flush()
  const { engine, cleanup } = await initEngine(doc)
  cleanups.push(() => doc.destroy(), cleanup)
  engine.selection.set([first, second])
  if (grouped) engine.groupSelection()
  doc.flush()
  doc.undo.stopCapturing()
  return { doc, engine, first, second }
}

const read = (doc: PleinDoc) =>
  [...doc.elements()]
    .map((el) => ({ id: el.id, kind: el.kind, parent: el.parentId, rect: doc.worldRect(el.id) }))
    .sort((a, b) => a.id.localeCompare(b.id))

describe('打组 / 解组与紧邻位置修改的撤销边界', () => {
  const cases = (['group', 'ungroup'] as const).flatMap((command) =>
    (['before', 'after'] as const).map((order) => [command, order] as const),
  )

  it.each(cases)('%s 与紧邻的 %s 位置修改分别撤销，不连带回退', async (command, order) => {
    const { doc, engine } = await setup(command === 'ungroup')
    const act = () => (command === 'group' ? engine.groupSelection() : engine.ungroupSelection())
    let expected: ReturnType<typeof read>
    if (order === 'before') {
      engine.nudge(17, 9)
      expected = read(doc)
      act()
    } else {
      act()
      expected = read(doc)
      engine.nudge(21, -12)
    }
    expect(read(doc)).not.toEqual(expected)
    // 两步紧挨着发生，仍在撤销合并时间窗内
    engine.undo()
    expect(read(doc)).toEqual(expected)
  })
})

it.each([
  [false, false],
  [true, false],
  [true, true],
])('批量解组 nested=%s reverse=%s 保留世界位置且整步撤销重做', async (nested, reverse) => {
  const { doc, engine, first, second } = await setup(true)
  const inner = engine.selection.values()[0]!
  const third = createElement(doc, node({ x: 1400, y: 300 }))
  engine.selection.set(nested ? [inner, third] : [third])
  engine.groupSelection()
  doc.flush()
  const frames = [...doc.elements()].filter((el) => el.kind === 'frame').map((el) => el.id)
  engine.selection.set(reverse ? frames.reverse() : frames)
  doc.undo.stopCapturing()
  const before = read(doc)
  engine.ungroupSelection()
  doc.flush()
  const after = read(doc)
  expect(after.map((el) => el.id).sort()).toEqual([first, second, third].sort())
  for (const el of after) expect(el.rect).toEqual(before.find((item) => item.id === el.id)!.rect)
  expect(engine.selection.values().sort()).toEqual([first, second, third].sort())
  engine.undo()
  expect(read(doc)).toEqual(before)
  engine.redo()
  expect(read(doc)).toEqual(after)
})
