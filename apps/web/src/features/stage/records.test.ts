import type { CanvasElement } from '@plein/doc'
import { defaultStageScene, STAGE_TYPE, type StageSnapshot } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { stageRecordsOf } from './records'

const shot: StageSnapshot = {
  resultId: 'shot',
  assetId: 'asset',
  rev: 0,
  render: 1,
  scene: defaultStageScene(),
  at: 1,
}
const element = (extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 'stage',
  kind: 'node',
  nodeType: STAGE_TYPE,
  x: 0,
  y: 0,
  w: 480,
  h: 270,
  rotation: 0,
  z: 'a',
  parentId: null,
  locked: false,
  params: { snapshots: [shot] },
  results: [
    {
      id: shot.resultId,
      port: 'image',
      value: { type: 'image', assetId: shot.assetId },
      runId: 'snap',
      at: 1,
    },
  ],
  adopted: shot.resultId,
  ...extra,
})

describe('构图来源与候选显示', () => {
  it('图片和来源匹配时可采用、恢复，采用状态来自实际结果', () => {
    expect(stageRecordsOf(element())).toMatchObject([
      { available: true, adopted: true, snapshot: shot },
    ])
  })
  it('无来源的候选仍可采用，不补造可恢复场景', () => {
    const records = stageRecordsOf(element({ params: { snapshots: [] } }))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ available: true, adopted: true, issue: 'missing' })
    expect(records[0]!.snapshot).toBeUndefined()
  })
  it('已移除候选只保留场景恢复能力，不假装仍可采用', () => {
    expect(
      stageRecordsOf(element({ results: [], params: { snapshots: [shot, null, shot] } })),
    ).toMatchObject([{ available: false, adopted: false, issue: 'removed', snapshot: shot }])
  })
  it('相同结果 ID 的其他图片不能借用错误来源', () => {
    const el = element()
    el.results![0]!.value = { type: 'image', assetId: 'different-image' }
    const records = stageRecordsOf(el)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      assetId: 'different-image',
      available: true,
      adopted: true,
      issue: 'missing',
    })
    expect(records[0]!.snapshot).toBeUndefined()
    expect(records[1]).toMatchObject({
      assetId: 'asset',
      available: false,
      adopted: false,
      issue: 'mismatch',
      snapshot: shot,
    })
  })
})
