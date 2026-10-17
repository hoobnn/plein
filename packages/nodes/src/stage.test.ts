import { describe, expect, it } from 'vite-plus/test'
import { defaultStageScene, type StageSnapshot, stageSnapshotFor, stageSnapshotsOf } from './stage'

const shot: StageSnapshot = {
  resultId: 'shot',
  assetId: 'asset',
  rev: 0,
  render: 1,
  scene: defaultStageScene(),
  at: 1,
}

describe('构图来源读取', () => {
  it('损坏记录不抹掉其他可恢复来源，重复记录只保留一条', () => {
    const other = { ...shot, resultId: 'other', assetId: 'other-asset' }
    expect(
      stageSnapshotsOf({ snapshots: [null, shot, { resultId: 'broken' }, shot, other] }),
    ).toEqual([shot, other])
  })
  it('指定候选跳过同 ID 的坏来源，读取首条有效来源', () => {
    const params = {
      snapshots: [{ resultId: shot.resultId, scene: null }, shot, { ...shot, rev: 8 }],
    }
    expect(stageSnapshotFor(params, shot.resultId)).toEqual(shot)
    expect(stageSnapshotsOf(params)).toEqual([shot])
  })
  it('缺失或非数组来源不构造默认来源', () => {
    expect(stageSnapshotsOf({ snapshots: 'invalid' })).toEqual([])
    expect(stageSnapshotFor(undefined, shot.resultId)).toBeUndefined()
    expect(stageSnapshotFor({ snapshots: [shot] }, 'missing')).toBeUndefined()
  })
})
