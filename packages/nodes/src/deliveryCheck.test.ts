import { describe, expect, it } from 'vite-plus/test'
import {
  DeliveryCheckReport,
  deliveryCheckAssets,
  deliveryCheckNode,
  DELIVERY_CHECK_RULES,
} from './deliveryCheck'

const fixture = () => ({
  format: 'plein-delivery-check',
  version: 1,
  at: 1,
  request: {
    scope: { canvasId: 'canvas', boardId: 'board', sequenceId: 'sequence' },
    deliveryId: 'delivery',
    resultId: 'output',
    runId: 'run',
    source: { assetId: 'a'.repeat(64), kind: 'video' },
    goal: { id: 'goal', snapshot: '{}' },
  },
  rules: DELIVERY_CHECK_RULES,
  engine: 'ffmpeg test',
  status: 'unchecked',
  checks: ['source', 'decode', 'spec', 'duration', 'audio', 'subtitles', 'black', 'silence'].map(
    (id) => ({ id, status: 'unchecked', detail: '未检查' }),
  ),
  observed: {
    complete: false,
    decodedFrames: 0,
    audioTracks: 0,
    audioDecoded: false,
    black: [],
    silence: [],
  },
  unchecked: ['创作内容未检查'],
})
describe('成片技术报告数据合同', () => {
  it('节点为免费本地job；严格报告声明源资产，不扫描任意JSON/hash文字', () => {
    expect(deliveryCheckNode.execution).toBe('job')
    expect(deliveryCheckNode.capability).toBeUndefined()
    expect(deliveryCheckNode.params.parse({})).toEqual({ historical: false })
    expect(deliveryCheckAssets(fixture())).toEqual(['a'.repeat(64)])
    expect(deliveryCheckAssets({ arbitrary: 'a'.repeat(64) })).toEqual([])
    expect(deliveryCheckAssets({ ...fixture(), format: 'unknown' })).toEqual([])
  })
  it('不完整、重复、缺哈希或无样本覆盖的检查不能伪装通过', () => {
    const allPassed = {
      ...fixture(),
      status: 'passed',
      checks: fixture().checks.map((c) => ({ ...c, status: 'passed' })),
    }
    expect(DeliveryCheckReport.safeParse(allPassed).success).toBe(false)
    const missing = fixture()
    missing.checks.pop()
    expect(DeliveryCheckReport.safeParse(missing).success).toBe(false)
    const duplicate = fixture()
    duplicate.checks[0]!.id = duplicate.checks[1]!.id
    expect(DeliveryCheckReport.safeParse(duplicate).success).toBe(false)
    const noCoverage = fixture()
    noCoverage.checks.find((c) => c.id === 'silence')!.status = 'passed'
    expect(DeliveryCheckReport.safeParse(noCoverage).success).toBe(false)
  })
  it('区间越界、异源字幕、超量结果和危险非有限数拒绝', () => {
    const bad = {
      ...fixture(),
      observed: { ...fixture().observed, duration: 2, black: [{ start: 1, end: 3 }] },
    }
    expect(DeliveryCheckReport.safeParse(bad).success).toBe(false)
    expect(
      DeliveryCheckReport.safeParse({
        ...fixture(),
        observed: { ...fixture().observed, decodedFrames: Infinity },
      }).success,
    ).toBe(false)
    const mismatch = {
      ...fixture(),
      request: {
        ...fixture().request,
        subtitles: {
          version: 1,
          basis: 'executed-sequence-spec',
          enabled: true,
          cues: [],
          resultId: 'other',
          assetId: 'a'.repeat(64),
        },
      },
    }
    expect(DeliveryCheckReport.safeParse(mismatch).success).toBe(false)
    expect(deliveryCheckAssets(bad)).toEqual([])
  })
})
