import { describe, expect, it } from 'vite-plus/test'
import {
  addResults,
  adoptResult,
  adoptResultManually,
  createDoc,
  createElement,
  currentResult,
  setResults,
  updateElement,
} from './index'

/**
 * 人工采用写版本记号：撤销/重做真的改了采用选择时补发新记号，
 * 系统缓存与自动采用不写。A→B→A 最终采用项相同，记号不同。
 */

const image = (id: string) => ({
  id,
  port: 'images',
  runId: `run-${id}`,
  at: 1,
  value: { type: 'image' as const, assetId: 'a'.repeat(64) },
})

function fixture() {
  const doc = createDoc(undefined, { schedule: () => {} })
  const id = createElement(doc, { kind: 'node', x: 0, y: 0, w: 10, h: 10 })
  addResults(doc, id, [image('A')])
  addResults(doc, id, [image('B')], { adopt: false })
  addResults(doc, id, [image('C')], { adopt: false })
  doc.flush()
  return { doc, id }
}

describe('人工采用的版本记号', () => {
  it('A→B→A 最终采用项相同但记号不同', () => {
    const { doc, id } = fixture()
    adoptResultManually(doc, id, 'A')
    const first = doc.get(id)!.adoptionRevision
    adoptResultManually(doc, id, 'B')
    const second = doc.get(id)!.adoptionRevision
    adoptResultManually(doc, id, 'A')
    const third = doc.get(id)!.adoptionRevision
    expect(new Set([first, second, third]).size).toBe(3)
    expect(currentResult(doc.get(id)!)!.id).toBe('A')
    doc.destroy()
  })

  it('撤销/重做真的改了采用时补发新记号，只改别的字段不动记号', () => {
    const { doc, id } = fixture()
    adoptResultManually(doc, id, 'A')
    const first = doc.get(id)!.adoptionRevision
    adoptResultManually(doc, id, 'B')
    doc.undo.stopCapturing()

    doc.undo.undo()
    expect(doc.get(id)!.adopted).toBe('A')
    const undone = doc.get(id)!.adoptionRevision
    expect(undone).toBeTruthy()
    expect(undone).not.toBe(first)

    doc.undo.redo()
    expect(doc.get(id)!.adopted).toBe('B')
    expect(doc.get(id)!.adoptionRevision).not.toBe(undone)

    // 普通改名撤销不推进采用记号
    const before = doc.get(id)!.adoptionRevision
    updateElement(doc, id, { name: '后来改名' })
    doc.undo.stopCapturing()
    doc.undo.undo()
    expect(doc.get(id)!.name).toBeUndefined()
    expect(doc.get(id)!.adoptionRevision).toBe(before)
    doc.destroy()
  })

  it('相邻改字与人工采用各自独立撤销', () => {
    const { doc, id } = fixture()
    adoptResult(doc, id, 'A')
    doc.undo.stopCapturing()
    adoptResultManually(doc, id, 'B')
    doc.undo.stopCapturing()
    updateElement(doc, id, { name: '新名字' })
    doc.undo.stopCapturing()

    doc.undo.undo()
    expect(doc.get(id)!.name).toBeUndefined()
    expect(doc.get(id)!.adopted).toBe('B')
    doc.undo.undo()
    expect(doc.get(id)!.adopted).toBe('A')
    expect(currentResult(doc.get(id)!)!.id).toBe('A')
    doc.destroy()
  })

  it('系统写入候选与整份替换不写采用记号', () => {
    const { doc, id } = fixture()
    addResults(doc, id, [image('D')])
    expect(doc.get(id)!.adoptionRevision).toBeUndefined()
    setResults(doc, id, [image('A')])
    expect(doc.get(id)!.adoptionRevision).toBeUndefined()
    doc.destroy()
  })
})
