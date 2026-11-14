import { describe, expect, it } from 'vite-plus/test'
import { addResults, createDoc, createElement, MAX_RESULTS, type CanvasElement } from './index'
import { fixedReferencedResultIds } from './domain/fixed-references'

/**
 * 固定剪辑引用的候选不能被 48 条窗口裁掉：
 * 裁掉了片段就找不到原候选，返工与可追溯都断了。
 */

// 素材 id 必须是 64 位十六进制：固定片段的合同要求可核对的文件身份
const assetId = (id: string) => id.repeat(64).slice(0, 64)

const image = (id: string, runId = `run-${id}`) => ({
  id,
  port: 'images',
  value: { type: 'image' as const, assetId: assetId('1') },
  runId,
  at: 1,
})

const video = (id: string, runId = `run-${id}`) => ({
  id,
  port: 'video',
  value: { type: 'video' as const, assetId: assetId('2') },
  runId,
  at: 1,
})

const holder = (
  selection: {
    canvasId: string
    nodeId: string
    port: string
    resultId: string
    runId: string
  },
  fileId = assetId('2'),
  localSelection?: {
    canvasId: string
    nodeId: string
    port: string
    resultId: string
    runId: string
  },
): CanvasElement => ({
  id: 'holder-1',
  kind: 'video',
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  rotation: 0,
  z: '',
  parentId: null,
  locked: false,
  videoSegment: {
    version: 1,
    segmentId: 'segment-1',
    asset: { assetId: fileId, kind: 'video' },
    duration: 3,
    selection,
    ...(localSelection ? { localSelection } : {}),
  },
})

describe('固定引用保护', () => {
  it('完整身份对得上才算引用', () => {
    const scope = { canvasId: 'canvas-1', nodeId: 'node-1', results: [video('R', 'run-1')] }
    const base = {
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      port: 'video',
      resultId: 'R',
      runId: 'run-1',
    }
    expect(fixedReferencedResultIds([holder(base)], scope)).toEqual(new Set(['R']))
    // 别的画布
    expect(fixedReferencedResultIds([holder({ ...base, canvasId: 'other' })], scope)).toEqual(
      new Set(),
    )
    // 别的运行
    expect(fixedReferencedResultIds([holder({ ...base, runId: 'other-run' })], scope)).toEqual(
      new Set(),
    )
    // 别的端口
    expect(fixedReferencedResultIds([holder({ ...base, port: 'lastFrame' })], scope)).toEqual(
      new Set(),
    )
    // 别的文件
    expect(fixedReferencedResultIds([holder(base, assetId('3'))], scope)).toEqual(new Set())
  })

  it('窗口裁剪时保留固定引用指向的候选', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const nodeId = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    doc.flush()
    // 先放一条会被固定引用的候选
    addResults(doc, nodeId, [video('pinned', 'run-pinned')], { adopt: false })
    // 固定片段引用它
    const holderId = createElement(doc, { kind: 'video', x: 0, y: 0, w: 100, h: 100 })
    doc.mutable(holderId)!.set('videoSegment', {
      version: 1,
      segmentId: 'segment-1',
      asset: { assetId: assetId('2'), kind: 'video' },
      duration: 3,
      selection: {
        canvasId: 'canvas-1',
        nodeId,
        port: 'video',
        resultId: 'pinned',
        runId: 'run-pinned',
      },
    })
    doc.flush()

    // 再塞满窗口
    const batch = Array.from({ length: MAX_RESULTS + 10 }, (_, i) => image(`c${i}`, `run-c${i}`))
    addResults(doc, nodeId, batch, { adopt: false, canvasId: 'canvas-1' })

    const ids = doc.get(nodeId)!.results!.map((r) => r.id)
    // 固定引用的候选没被裁掉
    expect(ids).toContain('pinned')
    // 被固定引用的计数可以超过窗口上限
    expect(ids.length).toBeGreaterThan(MAX_RESULTS)
    // 新加的候选也还在窗口里
    expect(ids).toContain('c0')
    doc.destroy()
  })
})

describe('固定候选超过普通窗口', () => {
  it('49 个不同固定候选与新候选同时保留，不受 48 条窗口影响', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const nodeId = createElement(doc, { kind: 'node', x: 0, y: 0, w: 200, h: 200 })
    // 先放固定片段：每个指向一条不同的候选
    for (let i = 0; i < 49; i++) {
      const holderId = createElement(doc, { kind: 'video', x: 0, y: 0, w: 10, h: 10 })
      doc.mutable(holderId)!.set('videoSegment', {
        version: 1,
        segmentId: `segment-${i}`,
        asset: { assetId: assetId('2'), kind: 'video' },
        duration: 3,
        selection: {
          canvasId: 'canvas-1',
          nodeId,
          port: 'video',
          resultId: `pin-${i}`,
          runId: `run-pin-${i}`,
        },
      })
    }
    doc.flush()
    const pinned = Array.from({ length: 49 }, (_, i) => video(`pin-${i}`, `run-pin-${i}`))
    addResults(doc, nodeId, pinned, { adopt: false, canvasId: 'canvas-1' })
    doc.flush()
    expect(doc.get(nodeId)!.results).toHaveLength(49)
    addResults(doc, nodeId, [video('fresh', 'run-fresh')], {
      adopt: false,
      canvasId: 'canvas-1',
    })
    doc.flush()
    const ids = doc.get(nodeId)!.results!.map((r) => r.id)
    expect(ids).toContain('fresh')
    expect(ids.filter((id) => id.startsWith('pin-'))).toHaveLength(49)
    expect(ids).toHaveLength(50)
    doc.destroy()
  })
})
