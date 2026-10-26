import {
  createDoc,
  createElement,
  editDelivery,
  exportElements,
  importElements,
  currentResult,
} from '@plein/doc'
import { sequenceNode } from '@plein/nodes'
import type { ComposeSpec, ExecutorContext, PortValue } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { coreServerPlugin } from './core'
import { appendDeliveryRecord } from './delivery'

// This test isolates the exact spec/metadata contract; compose is a controlled function, not libass.
vi.mock('../assets/media', async (original) => {
  const actual = await original<typeof import('../assets/media')>()
  return {
    ...actual,
    mediaCaps: async () => ({ ...(await actual.mediaCaps()), ffmpeg: true, subtitles: true }),
  }
})

describe('实际序列字幕计划', () => {
  it('compose使用的同一spec在await前冻结；append不按之后的params重算，legacy写入/复制保留未知可选字段', async () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      params: {},
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    let spec: ComposeSpec | undefined
    const params = sequenceNode.params.parse({
      clips: [{ source: 'clip', subtitle: '真正导出的字幕' }],
      aspectRatio: '16:9',
    })
    const inputs: Record<string, PortValue[]> = {
      clips: [{ type: 'video', kind: 'video', source: 'clip', assetId: 'a'.repeat(64) }],
    }
    const ctx = {
      params,
      inputs,
      progress: vi.fn(),
      media: {
        probe: async () => ({ duration: 2, hasVideo: true, hasAudio: false }),
        compose: async (value: ComposeSpec) => {
          spec = structuredClone(value)
          // Emulate live edits after the exporter has frozen the spec. They must not leak into evidence.
          params.clips[0]!.subtitle = '等待期间改稿'
          return { assetId: 'b'.repeat(64), kind: 'video' as const, mime: 'video/mp4' }
        },
      },
    } as unknown as ExecutorContext
    const executor = coreServerPlugin.executors.find((e) => e.node.type === 'plein/sequence')!
    const outputs = await executor.run(ctx)
    expect(outputs.video![0]!.subtitleEvidence!.cues).toEqual(spec!.subtitles!.cues)
    expect(outputs.video![0]!.subtitleEvidence!.cues[0]!.text).toBe('真正导出的字幕')
    const result = {
      id: 'actual-output',
      port: 'video',
      runId: 'export-run',
      at: 1,
      value: { type: 'video' as const, assetId: 'b'.repeat(64) },
    }
    appendDeliveryRecord(doc, id, [result], params, inputs, () => ({ duration: 2 }), {}, outputs)
    const record = doc.get(id)!.deliveries![0]!
    expect(record.subtitleEvidence).toMatchObject({
      assetId: result.value.assetId,
      resultId: result.id,
      cues: [{ start: 0, end: 2, text: '真正导出的字幕' }],
    })
    const unknown = { ...record, futureOptional: { keep: 'legacy-reader-must-preserve' } }
    doc.mutable(id)!.set('deliveries', [unknown])
    expect(
      editDelivery(doc, id, record.id, {
        notes: [{ id: 'n', time: 1, text: '仍需人工确认', resolved: false }],
      }),
    ).toBe(true)
    expect(editDelivery(doc, id, record.id, { confirm: true })).toBe(false)
    expect(doc.get(id)!.deliveries![0]!.subtitleEvidence).toEqual(record.subtitleEvidence)
    expect(
      (doc.get(id)!.deliveries![0] as unknown as { futureOptional: unknown }).futureOptional,
    ).toEqual(unknown.futureOptional)
    const destination = createDoc(undefined, { schedule: () => {} })
    const [copy] = importElements(destination, exportElements(doc, [id]), { canvasId: 'copied' })
    expect(destination.get(copy!)!.deliveries![0]).toEqual({
      ...doc.get(id)!.deliveries![0],
      historical: true,
    })
    expect(editDelivery(destination, copy!, record.id, { confirm: true })).toBe(false)
    expect(currentResult(destination.get(copy!)!)).toBeUndefined()
    destination.destroy()
    doc.destroy()
  })

  it('没有实际执行元数据的旧结果不伪造字幕计划，报告存在不改确认权限', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      params: {},
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    appendDeliveryRecord(
      doc,
      id,
      [
        {
          id: 'old',
          port: 'video',
          runId: 'run',
          at: 1,
          value: { type: 'video', assetId: 'a'.repeat(64) },
        },
      ],
      {},
      {},
      () => ({ duration: 2 }),
    )
    expect(doc.get(id)!.deliveries![0]!.subtitleEvidence).toBeUndefined()
    expect(doc.get(id)!.deliveries![0]!.confirmedAt).toBeUndefined()
    doc.destroy()
  })
})
