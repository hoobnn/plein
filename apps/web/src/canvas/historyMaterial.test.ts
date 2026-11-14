import {
  createElement,
  isVideoSegment,
  type HistoryEntry,
  type PleinDoc,
  setResults,
} from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { Asset } from '@plein/protocol'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { historyMaterial } from './historyMaterial'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const ASSET_ID = 'a'.repeat(64)
const origin = {
  canvasId: '原画布',
  nodeId: '原节点',
  port: 'video',
  resultId: '原候选',
  runId: '原运行',
}
const asset = (change: Partial<Asset> = {}): Asset => ({
  id: ASSET_ID,
  kind: 'video',
  mime: 'video/mp4',
  name: '生成视频.mp4',
  size: 10,
  width: 1920,
  height: 1080,
  duration: 5.2,
  variants: [],
  createdAt: 1,
  ...change,
})

function fixture(extra: Record<string, unknown> = {}) {
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
    x: 0,
    y: 0,
    w: 320,
    h: 180,
  })
  const result = {
    id: '候选',
    runId: '运行',
    port: 'video',
    at: 1,
    generationOrigin: origin,
    value: { type: 'video' as const, assetId: ASSET_ID, mime: 'video/mp4' },
    ...extra,
  }
  setResults(doc, id, [result])
  doc.flush()
  const entry: HistoryEntry = {
    elementId: id,
    result: doc.get(id)!.results![0]! as HistoryEntry['result'],
    adopted: true,
  }
  return { doc, id, result, entry }
}

describe('历史视频放到画布保留来源', () => {
  it('写出精确候选选择、原执行出处与真实时长', () => {
    const f = fixture()
    const material = historyMaterial(f.doc, '当前画布', f.entry, asset())
    if ('problem' in material) throw new Error(material.problem)
    const segment = material.input.videoSegment!
    expect(isVideoSegment(segment)).toBe(true)
    expect(segment.selection).toEqual({
      canvasId: '当前画布',
      nodeId: f.id,
      port: 'video',
      resultId: '候选',
      runId: '运行',
    })
    expect(segment.origin).toEqual(origin)
    expect(segment.duration).toBe(5.2)
    expect(segment.asset).toEqual({ assetId: ASSET_ID, kind: 'video', mime: 'video/mp4' })
    expect(material.input).toMatchObject({ kind: 'video', assetId: ASSET_ID, w: 480, h: 270 })
  })

  it('候选没有原执行出处时不发明 origin', () => {
    const f = fixture({ generationOrigin: undefined })
    const material = historyMaterial(f.doc, '当前画布', f.entry, asset())
    if ('problem' in material) throw new Error(material.problem)
    expect('origin' in material.input.videoSegment!).toBe(false)
  })

  it('原执行出处不完整时也不照搬', () => {
    const f = fixture({ generationOrigin: { canvasId: '原画布' } })
    const material = historyMaterial(f.doc, '当前画布', f.entry, asset())
    if ('problem' in material) throw new Error(material.problem)
    expect('origin' in material.input.videoSegment!).toBe(false)
  })

  it.each([
    [
      '节点删除',
      (f: ReturnType<typeof fixture>) => f.doc.ydoc.transact(() => f.doc.elementMaps.delete(f.id)),
    ],
    ['候选删除', (f: ReturnType<typeof fixture>) => setResults(f.doc, f.id, [])],
    [
      '候选换成另一次运行',
      (f: ReturnType<typeof fixture>) =>
        setResults(f.doc, f.id, [{ ...f.result, runId: '另一运行' }]),
    ],
    [
      '候选换成另一个文件',
      (f: ReturnType<typeof fixture>) =>
        setResults(f.doc, f.id, [
          { ...f.result, value: { ...f.result.value, assetId: 'b'.repeat(64) } },
        ]),
    ],
  ])('%s 时拒绝并说明原因', (_name, change) => {
    const f = fixture()
    change(f)
    f.doc.flush()
    const material = historyMaterial(f.doc, '当前画布', f.entry, asset())
    expect('problem' in material && material.problem).toBeTruthy()
  })

  it('旧候选无 runId 或读不到时长时仍可作普通视频放置，并说明来源缺失', () => {
    const legacy = fixture({ runId: '' })
    const withoutRun = historyMaterial(legacy.doc, '当前画布', legacy.entry, asset())
    if ('problem' in withoutRun) throw new Error(withoutRun.problem)
    expect('videoSegment' in withoutRun.input).toBe(false)
    expect(withoutRun.notice).toContain('没有记录生成任务')
    const f = fixture()
    const withoutDuration = historyMaterial(
      f.doc,
      '当前画布',
      f.entry,
      asset({ duration: undefined }),
    )
    if ('problem' in withoutDuration) throw new Error(withoutDuration.problem)
    expect('videoSegment' in withoutDuration.input).toBe(false)
    expect(withoutDuration.notice).toContain('读不到视频时长')
  })

  it('素材元信息与候选文件不一致时拒绝', () => {
    const f = fixture()
    expect(
      historyMaterial(f.doc, '当前画布', f.entry, asset({ id: 'b'.repeat(64) })),
    ).toHaveProperty('problem')
    expect(historyMaterial(f.doc, '当前画布', f.entry, asset({ kind: 'image' }))).toHaveProperty(
      'problem',
    )
  })

  it('无画布时不保存候选选择', () => {
    const f = fixture()
    expect(historyMaterial(f.doc, null, f.entry, asset())).toHaveProperty('problem')
  })

  it('普通图片素材仍是普通素材，不带视频选择', () => {
    const doc = openDoc()
    docs.push(doc)
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      ports: { inputs: [], outputs: [{ id: 'images', label: '图片', type: 'image' }] },
      x: 0,
      y: 0,
      w: 320,
      h: 180,
    })
    setResults(doc, id, [
      {
        id: '图',
        runId: '运行',
        port: 'images',
        at: 1,
        value: { type: 'image', assetId: ASSET_ID },
      },
    ])
    doc.flush()
    const entry: HistoryEntry = {
      elementId: id,
      result: doc.get(id)!.results![0]! as HistoryEntry['result'],
      adopted: true,
    }
    const material = historyMaterial(
      doc,
      null,
      entry,
      asset({ kind: 'image', duration: undefined }),
    )
    if ('problem' in material) throw new Error(material.problem)
    expect('videoSegment' in material.input).toBe(false)
  })
})
