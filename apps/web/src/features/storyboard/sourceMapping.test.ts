import type { Engine } from '@plein/canvas-core'
import {
  addSourceUnit,
  captureSourceSnapshot,
  confirmProductionContent,
  connect,
  createElement,
  currentProductionConfirmation,
  productionContentSnapshot,
  sourceMapOf,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { describe, expect, it, vi } from 'vite-plus/test'
import { placeTemplate, templateData } from '../../canvas/groups'
import { useCanvas } from '../../stores/canvas'
import { sourceDisplayOffset, sourceRawOffset, sourceSelectionAfterKey } from './sourceMapping'

describe('原文映射模板实例', () => {
  it('只读键盘选区按grapheme移动，Shift保持anchor，不能切开emoji', () => {
    const text = '甲：回来。\n乙：回来。\n😀'
    let range = { start: 6, end: 6, direction: 'none' as string }
    for (let i = 0; i < 5; i++)
      range = sourceSelectionAfterKey({ text, ...range, key: 'ArrowRight', shift: true })!
    expect(range).toEqual({ start: 6, end: 11, direction: 'forward' })
    expect(
      sourceSelectionAfterKey({
        text,
        start: 12,
        end: 12,
        direction: 'none',
        key: 'ArrowRight',
        shift: true,
      }),
    ).toEqual({ start: 12, end: 14, direction: 'forward' })
    expect(
      sourceSelectionAfterKey({
        text,
        start: 6,
        end: 11,
        direction: 'forward',
        key: 'ArrowLeft',
        shift: true,
      }),
    ).toEqual({ start: 6, end: 10, direction: 'forward' })
    expect(
      sourceSelectionAfterKey({
        text,
        start: 6,
        end: 6,
        direction: 'none',
        key: 'ArrowLeft',
        shift: true,
      }),
    ).toEqual({ start: 5, end: 6, direction: 'backward' })
    expect(
      sourceSelectionAfterKey({
        text: '\n甲',
        start: 0,
        end: 0,
        direction: 'none',
        key: 'Home',
        shift: false,
      }),
    ).toEqual({ start: 0, end: 0, direction: 'none' })
  })
  it('textarea归一化换行后的范围往返仍指向原文中的第二段和完整emoji', () => {
    const raw = '甲：回来。\r\n乙：回来。\r\n😀'
    expect(raw.slice(sourceRawOffset(raw, 6), sourceRawOffset(raw, 11))).toBe('乙：回来。')
    expect(sourceRawOffset(raw, 6)).toBe(7)
    expect(sourceRawOffset(raw, 11)).toBe(12)
    expect(sourceDisplayOffset(raw, 14)).toBe(12)
    expect(raw.slice(sourceRawOffset(raw, 12), sourceRawOffset(raw, 14))).toBe('😀')
  })
  it('实际templateData/placeTemplate重映射内部来源和标注，全文不改写、确认不继承', () => {
    const doc = openDoc()
    const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 500, h: 500 })
    const text = '甲：回来。\r\n😀原文不改写。'
    const source = createElement(
      doc,
      node({
        parentId: frame,
        nodeType: 'plein/text',
        params: { text },
        ports: { inputs: [], outputs: [{ id: 'text', type: 'text', label: '文本' }] },
      }),
    )
    const board = createElement(
      doc,
      node({
        parentId: frame,
        nodeType: 'plein/storyboard',
        params: { shots: [{ id: 'one', description: '回头' }] },
        ports: { inputs: [{ id: 'script', type: 'text', label: '剧本' }], outputs: [] },
      }),
    )
    connect(doc, [source, 'text'], [board, 'script'])
    const snapshotId = captureSourceSnapshot(doc, board, {
      canvasId: 'origin',
      elementId: source,
      port: 'text',
      expectedText: text,
    })!
    addSourceUnit(doc, board, { snapshotId, start: 0, end: 5, kind: 'dialogue' })
    confirmProductionContent(doc, {
      scope: { canvasId: 'origin', boardId: board },
      expectedSnapshot: productionContentSnapshot(doc.get(board))!,
      version: 'v1',
      userId: 'alice',
    })
    const fake = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
    const data = JSON.parse(JSON.stringify(templateData(fake, frame)))
    const targetDoc = openDoc()
    const target = {
      doc: targetDoc,
      selection: { set: vi.fn() },
      setTool: vi.fn(),
    } as unknown as Engine
    const before = useCanvas.getState()
    useCanvas.setState({ engine: target, canvasId: 'target' })
    try {
      const [root] = placeTemplate(target, data, { x: 100, y: 100 })
      const copied = targetDoc.descendants(root!).find((el) => el.nodeType === 'plein/storyboard')!
      const copiedSource = targetDoc.descendants(root!).find((el) => el.nodeType === 'plein/text')!
      const mapping = sourceMapOf(targetDoc, copied.id)
      expect(mapping.snapshots[0]!.text).toBe(text)
      expect(mapping.snapshots[0]!.id).not.toBe(snapshotId)
      expect(mapping.sources[0]!.binding!.elementId).toBe(copiedSource.id)
      expect(mapping.snapshots[0]!.originAtCapture.elementId).toBe(source)
      expect(mapping.units[0]!.snapshotId).toBe(mapping.snapshots[0]!.id)
      expect(currentProductionConfirmation(copied, 'target')).toBeUndefined()
      expect(copied.production!.confirmations.every((c) => c.historical)).toBe(true)
      targetDoc.undo.undo()
      expect(targetDoc.get(copied.id)).toBeUndefined()
      targetDoc.undo.redo()
      expect(sourceMapOf(targetDoc, copied.id)).toEqual(mapping)
    } finally {
      useCanvas.setState(before)
      targetDoc.destroy()
      doc.destroy()
    }
  })
})
