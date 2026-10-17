import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import { createDoc } from './doc'
import { createElement, ReadOnlyDocError } from './commands'
import { editDelivery, isDeliveryRecord, type DeliveryRecord } from './delivery'
import { node, openDoc } from './testing'

export const delivery: DeliveryRecord = {
  id: 'delivery_r1',
  resultId: 'r1',
  runId: 'run1',
  assetId: 'film1',
  kind: 'film',
  version: 'v1',
  createdAt: 1,
  width: 1920,
  height: 1080,
  duration: 5,
  sources: [{ source: 'shot1', shotId: 's1', start: 0, end: 5 }],
  notes: [],
}
describe('交付版本元数据', () => {
  it('时间码意见可撤销、重开；未解决意见阻止确认，新意见撤回确认，参数不变', () => {
    const doc = openDoc()
    const id = createElement(doc, node({ params: { prompt: 'keep' }, deliveries: [delivery] }))
    expect(
      editDelivery(doc, id, delivery.id, {
        notes: [{ id: 'n1', time: 1.2, text: '检查衔接', resolved: false, source: 'shot1' }],
      }),
    ).toBe(true)
    expect(editDelivery(doc, id, delivery.id, { confirm: true })).toBe(false)
    expect(doc.get(id)?.deliveries?.[0]?.confirmedAt).toBeUndefined()
    expect(
      editDelivery(doc, id, delivery.id, {
        notes: [{ id: 'n1', time: 1.2, text: '检查衔接', resolved: true, source: 'shot1' }],
      }),
    ).toBe(true)
    expect(editDelivery(doc, id, delivery.id, { confirm: true })).toBe(true)
    const approved = doc.get(id)?.deliveries?.[0]
    expect(approved?.confirmedAt).toBeTypeOf('number')
    expect(doc.get(id)?.params).toEqual({ prompt: 'keep' })
    doc.undo.undo()
    doc.flush()
    expect(doc.get(id)?.deliveries?.[0]?.confirmedAt).toBeUndefined()
    doc.undo.redo()
    doc.flush()
    expect(doc.get(id)?.deliveries?.[0]).toEqual(approved)
    const reloaded = createDoc(new Y.Doc(), { schedule: () => {} })
    Y.applyUpdate(reloaded.ydoc, Y.encodeStateAsUpdate(doc.ydoc))
    reloaded.flush()
    expect(reloaded.get(id)?.deliveries?.[0]).toEqual(approved)
    expect(
      editDelivery(doc, id, delivery.id, {
        notes: [...approved!.notes, { id: 'n2', time: 4, text: '再检查', resolved: false }],
      }),
    ).toBe(true)
    expect(doc.get(id)?.deliveries?.[0]?.confirmedAt).toBeUndefined()
    expect(
      editDelivery(doc, id, delivery.id, {
        notes: [{ id: 'bad', time: 7, text: '越界', resolved: false }],
      }),
    ).toBe(false)
    doc.destroy()
    reloaded.destroy()
  })
  it('坏记录不进入UI，readonly不能改确认', () => {
    expect(
      isDeliveryRecord({
        ...delivery,
        notes: [{ id: 'x', time: -1, text: '坏', resolved: false }],
      }),
    ).toBe(false)
    expect(isDeliveryRecord({ ...delivery, sources: [{ source: 'x', start: 4, end: 1 }] })).toBe(
      false,
    )
    const doc = openDoc()
    doc.readOnly = true
    expect(() => editDelivery(doc, 'x', 'x', { confirm: true })).toThrow(ReadOnlyDocError)
    doc.destroy()
  })
})
