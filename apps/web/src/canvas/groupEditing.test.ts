import { Engine } from '@plein/canvas-core'
import { referenceClipboard } from '@plein/capabilities'
import { connect, createElement, type PleinDoc } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { expect, it } from 'vite-plus/test'

const read = (doc: PleinDoc) =>
  [...doc.elements()]
    .map((el) => ({ id: el.id, kind: el.kind, parent: el.parentId, rect: doc.worldRect(el.id) }))
    .sort((a, b) => a.id.localeCompare(b.id))

it('连续复制嵌套分组保留内部连线、层级，每次复制可独立撤销', async () => {
  const doc = openDoc()
  const first = createElement(doc, node({ x: 400, y: 200 }))
  const second = createElement(doc, node({ x: 800, y: 200 }))
  const engine = new Engine({ host: {} as HTMLElement, doc, clipboard: referenceClipboard })
  engine.selection.set([first, second])
  engine.groupSelection()
  doc.flush()
  const inner = engine.selection.values()[0]!
  const third = createElement(doc, node({ x: 1400, y: 300 }))
  expect(connect(doc, [first, 'out'], [third, 'in'])).toBeTruthy()
  engine.selection.set([inner, third])
  engine.groupSelection()
  doc.flush()
  const before = read(doc)
  engine.duplicateSelection()
  const firstCopy = engine.selection.values()[0]!
  engine.duplicateSelection()
  const copied = read(doc)
  expect(copied).toHaveLength(before.length * 3)
  const roots = [...doc.elements()].filter((el) => !el.parentId)
  expect(roots).toHaveLength(3)
  expect([...doc.edges()]).toHaveLength(3)
  for (const root of roots) {
    const children = doc.descendants(root.id)
    expect(children).toHaveLength(4)
    expect(
      [...doc.elements()]
        .filter((el) => el.parentId === root.id)
        .map((el) => el.kind)
        .sort(),
    ).toEqual(['frame', 'node'])
    const ids = new Set(children.map((el) => el.id))
    expect(
      [...doc.edges()].filter((edge) => ids.has(edge.from[0]) && ids.has(edge.to[0])),
    ).toHaveLength(1)
  }
  const positions = roots.map((root) => doc.worldRect(root.id)!.x).sort((a, b) => a - b)
  expect(positions).toEqual([positions[0], positions[0]! + 24, positions[0]! + 48])
  engine.undo()
  expect(read(doc)).toHaveLength(before.length * 2)
  expect(doc.get(firstCopy)).toBeTruthy()
  engine.redo()
  expect(read(doc)).toEqual(copied)
  doc.destroy()
})
