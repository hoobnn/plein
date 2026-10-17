import { expect, test } from 'vite-plus/test'
import { comparePerfReports, type PerfReport } from '../../../../e2e/perf/report'

function report(): PerfReport {
  return {
    formatVersion: 1,
    sourceCommit: 'fixture',
    sourceDirty: false,
    measuredAt: '2026-01-01T00:00:00Z',
    environment: {
      runtime: 'node test',
      platform: 'test/test',
      browserVersion: 'test',
      renderer: 'SwiftShader',
      renderMode: 'software',
      viewport: { width: 1440, height: 900 },
    },
    fixture: {
      version: 2,
      elements: 1000,
      imageAssets: 32,
      videoAssets: 1,
      audioAssets: 1,
      serializedBytes: 1234,
    },
    rounds: 3,
    metrics: { 'cold.firstVisiblePreviewMs': 200, 'pan.jsMs': 1 },
    details: {},
  }
}

test('requires both relative and absolute slowdown, then identifies genuine regressions', () => {
  const baseline = report()
  const current = report()
  current.metrics['cold.firstVisiblePreviewMs'] = 300
  current.metrics['pan.jsMs'] = 2
  expect(comparePerfReports(current, baseline)).toEqual([])
  current.metrics['cold.firstVisiblePreviewMs'] = 401
  current.metrics['pan.jsMs'] = 4
  expect(comparePerfReports(current, baseline)).toHaveLength(2)
})

test('refuses to compare incompatible fixtures and execution environments', () => {
  for (const change of [
    (value: PerfReport) => {
      value.fixture.version++
    },
    (value: PerfReport) => {
      value.fixture.serializedBytes++
    },
    (value: PerfReport) => {
      value.environment.runtime = 'different runtime'
    },
    (value: PerfReport) => {
      value.environment.renderer = 'hardware GPU'
    },
    (value: PerfReport) => {
      value.environment.browserVersion = 'different browser'
    },
  ]) {
    const current = report()
    change(current)
    expect(() => comparePerfReports(current, report())).toThrow(/does not match/)
  }
})

test('refuses mismatched scenarios, insufficient rounds, and invalid measurements', () => {
  const current = report()
  current.rounds = 1
  expect(() => comparePerfReports(current, report())).toThrow(/at least three/)
  current.rounds = 3
  delete current.metrics['pan.jsMs']
  expect(() => comparePerfReports(current, report())).toThrow(/scenario set/)
  current.metrics['pan.jsMs'] = NaN
  expect(() => comparePerfReports(current, report())).toThrow(/Invalid performance/)
})

test('rejects failed diagnostic artifacts as baselines', () => {
  const baseline = report()
  baseline.status = 'failed'
  expect(() => comparePerfReports(report(), baseline)).toThrow(/failed or incomplete/)
})
