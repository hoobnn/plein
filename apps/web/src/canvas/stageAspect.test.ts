import { adoptResult, createDoc, createElement, setParam } from '@plein/doc'
import { defaultStageScene, STAGE_TYPE, type StageSnapshot } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { watchStageAspect } from './stageAspect'

function setup(sources = true) {
  const doc = createDoc(undefined, { schedule: () => {} })
  const scene = defaultStageScene()
  const snapshots: StageSnapshot[] = [
    { resultId: 'landscape', assetId: 'wide', rev: 0, render: 1, scene, at: 1 },
    {
      resultId: 'portrait',
      assetId: 'tall',
      rev: 1,
      render: 1,
      scene: { ...scene, aspect: '9:16' },
      at: 2,
    },
  ]
  const id = createElement(doc, {
    kind: 'node',
    nodeType: STAGE_TYPE,
    x: 100,
    y: 200,
    w: 270,
    h: 480,
    params: { scene: { ...scene, aspect: '1:1' }, snapshots: sources ? snapshots : [] },
    results: snapshots.map((s) => ({
      id: s.resultId,
      port: 'image',
      value: { type: 'image', assetId: s.assetId },
      runId: s.resultId,
      at: s.at,
    })),
    adopted: 'landscape',
  })
  doc.undo.clear()
  const ratio = () => doc.get(id)!.w / doc.get(id)!.h
  const center = () => {
    const el = doc.get(id)!
    return [el.x + el.w / 2, el.y + el.h / 2]
  }
  return { doc, id, snapshots, ratio, center }
}

describe('构图采用画幅', () => {
  it('已采用截图决定卡片形状，保留中心长边，采用和撤销重做均跟随', () => {
    const { doc, id, ratio, center } = setup()
    const before = center()
    const off = watchStageAspect(doc)
    doc.flush()
    expect(ratio()).toBeCloseTo(16 / 9, 2)
    expect(center()).toEqual(before)
    adoptResult(doc, id, 'portrait')
    doc.flush()
    expect(ratio()).toBeCloseTo(9 / 16, 2)
    expect(center()).toEqual(before)
    expect(Math.max(doc.get(id)!.w, doc.get(id)!.h)).toBe(480)
    expect(doc.get(id)!.params!.scene).toMatchObject({ aspect: '1:1' })
    doc.undo.undo()
    doc.flush()
    expect(ratio()).toBeCloseTo(16 / 9, 2)
    doc.undo.redo()
    doc.flush()
    expect(ratio()).toBeCloseTo(9 / 16, 2)
    off()
    doc.destroy()
  })

  it('来源缺失时不拿编辑场景猜测，来源到达后再匹配', () => {
    const { doc, id, snapshots, ratio } = setup(false)
    const off = watchStageAspect(doc)
    doc.flush()
    expect(ratio()).toBeCloseTo(9 / 16, 2)
    setParam(doc, id, 'snapshots', snapshots)
    doc.flush()
    expect(ratio()).toBeCloseTo(16 / 9, 2)
    off()
    doc.destroy()
  })

  it('只读画布不写入尺寸', () => {
    const { doc, ratio } = setup()
    doc.readOnly = true
    const off = watchStageAspect(doc)
    doc.flush()
    expect(ratio()).toBeCloseTo(9 / 16, 2)
    off()
    doc.destroy()
  })

  it('解绑后不再修改旧画布尺寸', () => {
    const { doc, id, ratio } = setup()
    const off = watchStageAspect(doc)
    doc.flush()
    off()
    adoptResult(doc, id, 'portrait')
    doc.flush()
    expect(ratio()).toBeCloseTo(16 / 9, 2)
    doc.destroy()
  })
})
