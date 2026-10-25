import { createElement, currentResult, type Edge } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { describe, expect, it } from 'vite-plus/test'
import { sequenceInputValue, sequenceSourceIdentity, sequenceTupleLabel } from './instanceModel'

describe('sequence UI exact input identity', () => {
  it('reads the connected side output, including result/port/edge, without substituting primary', () => {
    const doc = openDoc()
    const id = createElement(
      doc,
      node({
        adopted: 'main',
        results: [
          {
            id: 'main',
            runId: 'old-job',
            outputGroup: 'a',
            port: 'video',
            at: 1,
            value: { type: 'video', assetId: 'main-file' },
          },
          {
            id: 'alternate',
            runId: 'old-job',
            outputGroup: 'a',
            port: 'alternate',
            at: 1,
            value: { type: 'video', assetId: 'alt-file' },
          },
        ],
      }),
    )
    const source = doc.get(id)!
    const edge: Edge = { id: 'edge-side', from: [id, 'alternate'], to: ['sequence', 'clips'] }
    const value = sequenceInputValue(
      source,
      edge,
      currentResult(source, 'alternate')?.value,
      'canvas',
    )
    expect(value).toMatchObject({
      assetId: 'alt-file',
      source: id,
      sourcePort: 'alternate',
      edgeId: 'edge-side',
      resultId: 'alternate',
      runId: 'old-job',
      sourceCanvasId: 'canvas',
    })
    expect(value).not.toHaveProperty('generationOrigin')
    expect(
      sequenceInputValue(source, { ...edge, from: [id, 'missing'] }, undefined, 'canvas'),
    ).toMatchObject({ assetId: '', sourcePort: 'missing', edgeId: 'edge-side' })
    expect(
      sequenceInputValue(source, { ...edge, from: [id, 'missing'] }, undefined),
    ).not.toHaveProperty('resultId')
    doc.destroy()
  })

  it('direct video origin remains unknown and same asset uses retain different instance identity', () => {
    const doc = openDoc(),
      id = createElement(doc, { kind: 'video', assetId: 'file', x: 0, y: 0, w: 100, h: 100 })
    const value = sequenceInputValue(
      doc.get(id)!,
      { id: 'e', from: [id, 'video'], to: ['s', 'clips'] },
      { type: 'video', assetId: 'file' },
      'canvas',
    )
    expect(value).not.toHaveProperty('resultId')
    expect(value).not.toHaveProperty('generationOrigin')
    const row = { clipInstanceId: 'a', source: id, port: 'video', clip: { assetId: 'file' } }
    expect(sequenceSourceIdentity(row)).not.toBe(
      sequenceSourceIdentity({ ...row, clipInstanceId: 'b' }),
    )
    expect(sequenceSourceIdentity(row)).not.toBe(
      sequenceSourceIdentity({ ...row, clip: { assetId: 'new-file' } }),
    )
    doc.destroy()
  })

  it('preserves a known complete original execution tuple independently of current aliases', () => {
    const doc = openDoc()
    const generationOrigin = {
      canvasId: 'original-canvas',
      nodeId: 'original-node',
      port: 'original-output',
      resultId: 'original-result',
      runId: 'original-job',
    }
    const id = createElement(
      doc,
      node({
        adopted: 'local-result',
        results: [
          {
            id: 'local-result',
            runId: 'imported-job-alias',
            port: 'alternate',
            at: 1,
            generationOrigin,
            value: { type: 'video', assetId: 'a'.repeat(64) },
          },
        ],
      }),
    )
    const source = doc.get(id)!
    const value = sequenceInputValue(
      source,
      { id: 'local-edge', from: [id, 'alternate'], to: ['seq', 'clips'] },
      currentResult(source, 'alternate')?.value,
      'local-canvas',
    )
    expect(value).toMatchObject({
      source: id,
      sourceCanvasId: 'local-canvas',
      sourcePort: 'alternate',
      resultId: 'local-result',
      runId: 'imported-job-alias',
      generationOrigin,
    })
    expect(value).not.toHaveProperty('originCanvasId')
    expect(sequenceTupleLabel(generationOrigin)).toBe(
      'original-canvas / original-node / original-output / original-result / original-job',
    )
    expect(sequenceTupleLabel({ ...generationOrigin, runId: undefined })).toBe('未知')
    const row = { clipInstanceId: 'use', clip: { assetId: 'a'.repeat(64), generationOrigin } }
    expect(sequenceSourceIdentity(row)).not.toBe(
      sequenceSourceIdentity({
        ...row,
        clip: {
          ...row.clip,
          generationOrigin: { ...generationOrigin, runId: 'another-original-job' },
        },
      }),
    )
    doc.destroy()
  })
})
