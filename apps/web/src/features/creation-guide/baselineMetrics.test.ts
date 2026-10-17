import { Shot } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { summarizeBaseline, type BaselineObservation } from './baselineMetrics'

const fixtures = import.meta.glob(
  '../../../../../docs/benchmarks/creative-baselines/{two-person-dialogue,action-continuity,strong-style}.json',
  { eager: true, import: 'default' },
)

describe('创作基线脚手架', () => {
  it('三类固定输入能被本机Shot合同读取，观测字段保持待测而非捏造0或通过', () => {
    for (const id of ['two-person-dialogue', 'action-continuity', 'strong-style']) {
      const raw = fixtures[`../../../../../docs/benchmarks/creative-baselines/${id}.json`]
      const fixture = raw as {
        id: string
        format: string
        version: number
        trialShotId: string
        shots: unknown[]
        measurement: Record<string, unknown>
        manualChecks: string[]
      }
      expect(fixture.id).toBe(id)
      expect(fixture.format).toBe('plein-creative-baseline')
      expect(fixture.version).toBe(1)
      const shots = fixture.shots.map((item) => Shot.parse(item))
      expect(shots.length).toBeGreaterThanOrEqual(2)
      expect(new Set(shots.map((shot) => shot.id)).size).toBe(shots.length)
      expect(shots.some((shot) => shot.id === fixture.trialShotId)).toBe(true)
      expect(fixture.manualChecks.length).toBeGreaterThan(0)
      expect(fixture.measurement).toMatchObject({
        firstShotComplete: null,
        humanActions: null,
        videoSubmits: null,
        quality: 'pending-manual',
        evidence: [],
      })
    }
  })

  it('合成观测只验证计数：不把待测算成功，不把poll/音频提交算视频submit', () => {
    const runs: BaselineObservation[] = [
      {
        runId: 'synthetic-1',
        fixtureId: 'test',
        evidence: ['unit-test-only'],
        firstShotComplete: true,
        quality: 'pending-manual',
        events: [
          { id: 'click', type: 'human-action' },
          { id: 'video1', type: 'provider-submit', capability: 'video.generate' },
          { id: 'audio1', type: 'provider-submit', capability: 'audio.speech' },
        ],
      },
      {
        runId: 'synthetic-2',
        fixtureId: 'test',
        evidence: ['unit-test-only'],
        firstShotComplete: false,
        quality: 'reviewed',
        events: [{ id: 'video-failed', type: 'provider-submit', capability: 'video.generate' }],
      },
      {
        runId: 'pending',
        fixtureId: 'test',
        evidence: [],
        firstShotComplete: null,
        quality: 'pending-manual',
        events: null,
      },
    ]
    expect(summarizeBaseline(runs)).toEqual({
      observedRuns: 2,
      pendingRuns: 1,
      firstShotCompletions: 1,
      firstShotCompletionRate: 0.5,
      humanActions: null,
      videoSubmits: null,
      pendingManualReviews: 2,
    })
    expect(summarizeBaseline(runs.slice(0, 2))).toMatchObject({ humanActions: 1, videoSubmits: 2 })
    expect(summarizeBaseline([])).toMatchObject({
      firstShotCompletionRate: null,
      humanActions: null,
      videoSubmits: null,
    })
  })

  it('拒绝无证据测量和重复计数', () => {
    const run: BaselineObservation = {
      runId: 'run',
      fixtureId: 'test',
      evidence: [],
      firstShotComplete: true,
      quality: 'pending-manual',
      events: [],
    }
    expect(() => summarizeBaseline([run])).toThrow('证据')
    run.evidence = ['unit-test-only']
    expect(() => summarizeBaseline([run, run])).toThrow('重复')
    run.events = [
      { id: 'duplicate', type: 'human-action' },
      { id: 'duplicate', type: 'human-action' },
    ]
    expect(() => summarizeBaseline([run])).toThrow('重复')
  })
})
