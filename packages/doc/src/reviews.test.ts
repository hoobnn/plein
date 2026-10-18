import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import {
  addResults,
  adoptResult,
  createElement,
  resultHistory,
  setParam,
  updateElement,
} from './commands'
import { duplicateElements } from './clipboard'
import { ReadOnlyDocError } from './commands'
import { creativeReviewTarget, getCreativeReview, recordCreativeReview } from './reviews'
import { box, node, openDoc } from './testing'
import { SCHEMA_VERSION } from './migrate'

describe('独立的创作验收元数据', () => {
  it('采用尾帧后主视频与尾帧均生效，分别记录验收且不串用意见', () => {
    const doc = openDoc()
    const id = createElement(
      doc,
      node({
        ports: {
          inputs: [],
          outputs: [
            { id: 'video', label: '视频', type: 'video' },
            { id: 'lastFrame', label: '尾帧', type: 'image' },
          ],
        },
      }),
    )
    addResults(
      doc,
      id,
      ['a', 'b'].flatMap((outputGroup) => [
        {
          id: `video-${outputGroup}`,
          port: 'video',
          runId: 'run',
          outputGroup,
          at: 1,
          value: { type: 'video' as const, assetId: `video-${outputGroup}` },
        },
        {
          id: `tail-${outputGroup}`,
          port: 'lastFrame',
          runId: 'run',
          outputGroup,
          at: 1,
          value: { type: 'image' as const, assetId: `tail-${outputGroup}` },
        },
      ]),
    )
    const stale = creativeReviewTarget(doc.get(id), 'lastFrame')!
    adoptResult(doc, id, 'tail-b')
    const video = creativeReviewTarget(doc.get(id))!
    expect(video.resultId).toBe('video-b')
    const tail = creativeReviewTarget(doc.get(id), 'lastFrame')!
    expect(
      resultHistory(doc)
        .filter((r) => r.adopted)
        .map((r) => r.result.id),
    ).toEqual(['video-b', 'tail-b'])
    expect(recordCreativeReview(doc, id, { target: stale, status: 'usable' })).toBe(false)
    doc.undo.clear()
    expect(
      recordCreativeReview(doc, id, { target: video, status: 'usable', note: '视频可用' }),
    ).toBe(true)
    expect(
      recordCreativeReview(doc, id, { target: tail, status: 'changes', note: '尾帧需修改' }),
    ).toBe(true)
    expect(getCreativeReview(doc.get(id))?.note).toBe('视频可用')
    expect(getCreativeReview(doc.get(id), tail)?.note).toBe('尾帧需修改')
    expect(doc.get(id)?.adopted).toBe('tail-b')
    doc.undo.undo()
    expect(getCreativeReview(doc.get(id), tail)).toBeUndefined()
    expect(getCreativeReview(doc.get(id))?.note).toBe('视频可用')
    doc.undo.redo()
    const [copy] = duplicateElements(doc, [id])
    expect(getCreativeReview(doc.get(copy!))?.note).toBe('视频可用')
    expect(getCreativeReview(doc.get(copy!), tail)?.note).toBe('尾帧需修改')
  })
  it('绑定具体候选而非素材去重，不改变生成参数和采用项；迟到操作不能确认新版本', () => {
    const doc = openDoc()
    const id = createElement(
      doc,
      node({
        params: { prompt: '雨夜' },
        ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
      }),
    )
    addResults(doc, id, [
      {
        id: 'r1',
        port: 'video',
        runId: 'run1',
        at: 1,
        value: { type: 'video', assetId: 'same-asset' },
      },
    ])
    const target = creativeReviewTarget(doc.get(id))!
    expect(
      recordCreativeReview(doc, id, {
        target,
        status: 'changes',
        tags: ['continuity', 'continuity'],
        note: '  衣服颜色跳了  ',
      }),
    ).toBe(true)
    expect(getCreativeReview(doc.get(id))).toMatchObject({
      status: 'changes',
      tags: ['continuity'],
      note: '衣服颜色跳了',
    })
    expect(doc.get(id)?.params).toEqual({ prompt: '雨夜' })
    expect(doc.get(id)?.adopted).toBe('r1')
    addResults(doc, id, [
      {
        id: 'r2',
        port: 'video',
        runId: 'run2',
        at: 2,
        value: { type: 'video', assetId: 'same-asset' },
      },
    ])
    expect(getCreativeReview(doc.get(id))).toBeUndefined()
    expect(recordCreativeReview(doc, id, { target, status: 'usable' })).toBe(false)
    expect(getCreativeReview(doc.get(id), target)?.status).toBe('changes')
    adoptResult(doc, id, 'r1')
    expect(getCreativeReview(doc.get(id))?.status).toBe('changes')
    setParam(doc, id, 'prompt', '新要求')
    expect(getCreativeReview(doc.get(id))?.target).toEqual(target)
    doc.destroy()
  })

  it('明确保存为一步撤销，重开、复制和序列化仍保留；无候选与坏数据不判为通过', () => {
    const doc = openDoc()
    const id = createElement(doc, box({ assetId: 'image1' }))
    const target = creativeReviewTarget(doc.get(id))!
    doc.undo.clear()
    expect(recordCreativeReview(doc, id, { target, status: 'usable' })).toBe(true)
    expect(doc.undo.undoStack).toHaveLength(1)
    recordCreativeReview(doc, id, { target, status: 'usable' })
    expect(doc.undo.undoStack).toHaveLength(1)
    doc.undo.undo()
    expect(getCreativeReview(doc.get(id))).toBeUndefined()
    doc.undo.redo()
    expect(getCreativeReview(doc.get(id))?.status).toBe('usable')
    const [copy] = duplicateElements(doc, [id])
    expect(getCreativeReview(doc.get(copy!))?.status).toBe('usable')
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(doc.ydoc))
    const reopened = openDoc(raw)
    expect(getCreativeReview(reopened.get(id))).toEqual(getCreativeReview(doc.get(id)))
    updateElement(reopened, id, { assetId: 'image2' })
    expect(getCreativeReview(reopened.get(id))).toBeUndefined()
    expect(creativeReviewTarget(undefined)).toBeUndefined()
    expect(creativeReviewTarget({ ...doc.get(id)!, kind: 'node', results: [] })).toBeUndefined()
    reopened
      .mutable(id)!
      .set('reviews', [
        null,
        { status: 'usable' },
        { target, status: 'usable', tags: [], note: '', at: NaN },
      ])
    expect(reopened.get(id)?.reviews).toEqual([])
    reopened.meta.set('schemaVersion', SCHEMA_VERSION + 1)
    const future = openDoc(reopened.ydoc)
    expect(() => recordCreativeReview(future, id, { target, status: 'pending' })).toThrow(
      ReadOnlyDocError,
    )
    future.destroy()
    reopened.destroy()
    doc.destroy()
  })
})
