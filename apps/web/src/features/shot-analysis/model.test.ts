import {
  addResults,
  connect,
  createDoc,
  createElement,
  currentResult,
  deleteElements,
  setParam,
} from '@plein/doc'
import { SHOT_ANALYSIS_TYPE, type ShotAnalysisManifest } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { outputPort } from '../../canvas/presets'
import {
  analysisInputAssetId,
  analysisManifest,
  parseAnalysisCuts,
  placeAnalysisAssets,
} from './model'

function seed() {
  const doc = createDoc()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: SHOT_ANALYSIS_TYPE,
    x: 0,
    y: 0,
    w: 280,
    h: 200,
    ports: {
      inputs: [{ id: 'video', label: '原视频', type: 'video' }],
      outputs: [{ id: 'analysis', label: '拉片清单', type: 'json' }],
    },
  })
  const manifest: ShotAnalysisManifest = {
    version: 1,
    source: { assetId: 'a'.repeat(64), kind: 'video', mime: 'video/mp4' },
    timeBasis: 'first-video-frame',
    firstVideoPts: 7,
    duration: 2,
    algorithm: {
      name: 'ffmpeg-scene',
      version: 1,
      threshold: 0.3,
      minSceneSeconds: 0.4,
      manual: false,
    },
    scenes: [
      {
        id: 'one',
        start: 0,
        end: 2,
        frame: {
          assetId: 'b'.repeat(64),
          kind: 'image',
          mime: 'image/jpeg',
          at: 1,
          actualAt: 0,
          actualEnd: 2,
        },
        clip: { assetId: 'c'.repeat(64), kind: 'video', mime: 'video/mp4' },
      },
    ],
    audio: { assetId: 'd'.repeat(64), kind: 'audio', mime: 'audio/mp4' },
    notes: [],
  }
  addResults(doc, id, [
    {
      id: 'report',
      port: 'analysis',
      value: { type: 'json', value: manifest },
      runId: 'run',
      at: 1,
    },
  ])
  return { doc, id, manifest }
}

describe('拉片清单动作', () => {
  it('准确解析时间码并拒绝乱序与边界', () => {
    expect(parseAnalysisCuts('00:00.20, 0.4', 2)).toEqual([0.2, 0.4])
    expect(parseAnalysisCuts('', 2)).toEqual([])
    for (const value of ['0', '2', '1,0.5', 'oops', '-1', 'NaN'])
      expect(() => parseAnalysisCuts(value, 2)).toThrow()
  })
  it('所选清单入画布保存源区间，整批可一次撤销，且不改采用结果或执行参数', () => {
    const { doc, id } = seed()
    setParam(doc, id, 'threshold', 0.3)
    const created = placeAnalysisAssets(doc, id, 'report', ['one'], 'clips')
    expect(created).toHaveLength(1)
    expect(doc.get(created[0]!)?.assetId).toBe('c'.repeat(64))
    expect(doc.get(created[0]!)?.params?.shotAnalysisOrigin).toEqual({
      sourceAssetId: 'a'.repeat(64),
      start: 0,
      end: 2,
      timeBasis: 'first-video-frame',
    })
    expect(currentResult(doc.get(id)!)?.id).toBe('report')
    expect(doc.get(id)?.params).toEqual({ threshold: 0.3 })
    doc.undo.undo()
    expect(doc.get(created[0]!)).toBeUndefined()
    expect(analysisManifest(doc, id, 'report')).toBeDefined()
    doc.destroy()
  })
  it('只读和已删除报告拒绝写入，历史报告只显式预览不自动采用', () => {
    const { doc, id, manifest } = seed()
    addResults(doc, id, [
      {
        id: 'new',
        port: 'analysis',
        value: { type: 'json', value: manifest },
        runId: 'new',
        at: 2,
      },
    ])
    expect(analysisManifest(doc, id, 'report')?.result.id).toBe('report')
    expect(currentResult(doc.get(id)!)?.id).toBe('new')
    doc.readOnly = true
    expect(() => placeAnalysisAssets(doc, id, 'report', ['one'], 'frames')).toThrow()
    doc.readOnly = false
    deleteElements(doc, [id])
    expect(() => placeAnalysisAssets(doc, id, 'report', ['one'], 'frames')).toThrow('变化')
    doc.destroy()
  })
  it('视频输入绑定实际输出端口及当前采用，换线后不会误用primary', () => {
    const { doc, id } = seed()
    const source = createElement(doc, {
      kind: 'node',
      nodeType: 'test/multi',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      ports: {
        inputs: [],
        outputs: [
          { id: 'main', label: '主要输出', type: 'video' },
          { id: 'alternate', label: '次要输出', type: 'video' },
        ],
      },
    })
    addResults(doc, source, [
      {
        id: 'main',
        port: 'main',
        value: { type: 'video', assetId: 'e'.repeat(64) },
        runId: 'multi',
        at: 2,
      },
      {
        id: 'alternate',
        port: 'alternate',
        value: { type: 'video', assetId: 'a'.repeat(64) },
        runId: 'multi',
        at: 2,
      },
    ])
    connect(doc, [source, 'alternate'], [id, 'video'])
    expect(outputPort(doc.get(source)!, 'video', 'a'.repeat(64))?.id).toBe('alternate')
    expect(analysisInputAssetId(doc, id)).toBe('a'.repeat(64))
    connect(doc, [source, 'main'], [id, 'video'])
    expect(analysisInputAssetId(doc, id)).toBe('e'.repeat(64))
    doc.destroy()
  })
})
