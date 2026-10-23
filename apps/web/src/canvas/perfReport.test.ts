import { expect, test } from 'vite-plus/test'
import type { CanvasElement, Edge } from '@plein/doc'
import { demoContentHash, fixtureContentHash } from '../../../../e2e/perf/fixtures'
import {
  assertCompletePerfReport,
  comparePerfReports,
  EXPECTED_METRIC_KEYS,
  PERF_FORMAT_VERSION,
  type PerfReport,
} from '../../../../e2e/perf/report'

const PAN = '平移.jsMs'
const OPEN = 'cold.firstVisiblePreviewMs'

function report(): PerfReport {
  const metrics = Object.fromEntries(
    EXPECTED_METRIC_KEYS.map((key) => [key, key.endsWith('.jsMs') ? 1 : 200]),
  )
  return {
    formatVersion: PERF_FORMAT_VERSION,
    status: 'complete',
    buildFingerprint: 'a'.repeat(64),
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
      contentHash: 'b'.repeat(64),
      demoContentHash: 'c'.repeat(64),
    },
    rounds: 3,
    metrics,
    samples: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, [value + 0.25, value - 0.25, value]]),
    ),
    details: {},
  }
}

function setMeasurement(value: PerfReport, key: string, measurement: number) {
  value.metrics[key] = measurement
  value.samples[key] = [measurement + 0.25, measurement - 0.25, measurement]
}

test('requires both relative and absolute slowdown, then identifies genuine regressions', () => {
  const baseline = report()
  const current = report()
  setMeasurement(current, OPEN, 300)
  setMeasurement(current, PAN, 2)
  expect(comparePerfReports(current, baseline)).toEqual([])
  setMeasurement(current, OPEN, 401)
  setMeasurement(current, PAN, 4)
  expect(comparePerfReports(current, baseline)).toEqual([
    { metric: OPEN, baseline: 200, current: 401 },
    { metric: PAN, baseline: 1, current: 4 },
  ])
})

test.each([
  [OPEN, 1000, 1500],
  [OPEN, 100, 200],
  [PAN, 1, 3],
  ['cold.visibleMediaSettledMs', 200, 400],
] as const)('accepts exact threshold boundary: %s, %s -> %s', (metric, before, after) => {
  const baseline = report()
  const current = report()
  setMeasurement(baseline, metric, before)
  setMeasurement(current, metric, after)
  expect(comparePerfReports(current, baseline)).toEqual([])
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
      value.fixture.contentHash = 'd'.repeat(64)
    },
    (value: PerfReport) => {
      value.fixture.demoContentHash = 'd'.repeat(64)
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
    (value: PerfReport) => {
      value.environment.platform = 'different/platform'
    },
    (value: PerfReport) => {
      value.environment.viewport.width++
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
  delete current.metrics[PAN]
  expect(() => comparePerfReports(current, report())).toThrow(/scenario set/)
  current.metrics[PAN] = NaN
  expect(() => comparePerfReports(current, report())).toThrow(/Invalid performance/)
})

test.each([undefined, 'failed', 'partial'])('rejects non-complete report status: %s', (status) => {
  for (const side of ['current', 'baseline'] as const) {
    const current = report()
    const baseline = report()
    Object.assign(side === 'current' ? current : baseline, { status })
    expect(() => comparePerfReports(current, baseline)).toThrow(/failed or incomplete/)
  }
})

test.each([undefined, 1, 3, '2'])('rejects unsupported versions even when both match: %s', (v) => {
  const current = report()
  const baseline = report()
  Object.assign(current, { formatVersion: v })
  Object.assign(baseline, { formatVersion: v })
  expect(() => comparePerfReports(current, baseline)).toThrow(/formatVersion/)
})

test('rejects empty or identically filtered suites, absent samples, and unknown metrics', () => {
  for (const empty of [false, true]) {
    const current = report()
    const baseline = report()
    for (const value of [current, baseline]) {
      if (empty) {
        value.metrics = {}
        value.samples = {}
      } else {
        delete value.metrics[PAN]
        delete value.samples[PAN]
      }
    }
    expect(() => comparePerfReports(current, baseline)).toThrow(/complete metric\/scenario set/)
  }
  const noSamples = { ...report(), samples: undefined }
  expect(() => assertCompletePerfReport(noSamples)).toThrow(/complete metric\/scenario set/)
  const extra = report()
  extra.metrics['unknown.jsMs'] = 1
  extra.samples['unknown.jsMs'] = [1, 1, 1]
  expect(() => assertCompletePerfReport(extra)).toThrow(/complete metric\/scenario set/)
})

test.each([NaN, Infinity, -1, '1', null, undefined])(
  'rejects invalid raw samples: %s',
  (sample) => {
    const value = report()
    value.samples[PAN] = [1, sample, 1] as number[]
    expect(() => assertCompletePerfReport(value)).toThrow(/Invalid performance measurement/)
  },
)

test('rejects sparse or missing rounds, forged medians, and unequal valid round counts', () => {
  const value = report()
  value.samples[PAN] = [1, 1, 1]
  Reflect.deleteProperty(value.samples[PAN], '1')
  expect(() => assertCompletePerfReport(value)).toThrow(/Invalid performance measurement/)
  value.samples[PAN] = [1, 1]
  expect(() => assertCompletePerfReport(value)).toThrow(/round samples/)
  value.samples[PAN] = [1, 2, 3]
  value.metrics[PAN] = 1
  expect(() => assertCompletePerfReport(value)).toThrow(/sample median/)
  value.rounds = 4
  for (const key of EXPECTED_METRIC_KEYS)
    value.samples[key] = [value.metrics[key]!, 0, value.metrics[key]! + 1, 0]
  expect(() => assertCompletePerfReport(value)).not.toThrow()
  expect(() => comparePerfReports(value, report())).toThrow(/same sample count/)
})

test('rejects absent provenance, invalid hashes and incomplete execution metadata', () => {
  for (const value of [
    { ...report(), buildFingerprint: '' },
    { ...report(), measuredAt: 'invalid date' },
    { ...report(), environment: { ...report().environment, runtime: '' } },
    { ...report(), environment: { ...report().environment, renderMode: 'unknown' } },
    { ...report(), fixture: { ...report().fixture, contentHash: '' } },
    { ...report(), fixture: { ...report().fixture, demoContentHash: '' } },
  ])
    expect(() => assertCompletePerfReport(value)).toThrow(/Invalid performance/)
})

test('rejects software fallback mislabeled as hardware even when both reports match', () => {
  for (const renderer of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)',
    'llvmpipe (LLVM 18.1.8, 256 bits)',
    'Microsoft Basic Render Driver',
    'WebKit WebGL',
  ]) {
    const baseline = report()
    const current = report()
    for (const value of [baseline, current]) {
      value.environment.renderer = renderer
      value.environment.renderMode = 'hardware'
    }
    expect(() => comparePerfReports(current, baseline)).toThrow(/Hardware renderer/)
  }
  const unobserved = report()
  unobserved.environment.renderer = 'unobserved'
  expect(() => assertCompletePerfReport(unobserved)).toThrow(/execution environment/)
})

function demo(prefix: string): { elements: CanvasElement[]; edges: Edge[] } {
  return {
    elements: [
      {
        id: `${prefix}-frame`,
        kind: 'frame',
        x: 10,
        y: 20,
        w: 500,
        h: 400,
        rotation: 0,
        z: 'a0',
        parentId: null,
        locked: false,
      },
      {
        id: `${prefix}-node`,
        kind: 'node',
        x: 30,
        y: 40,
        w: 240,
        h: 180,
        rotation: 0,
        z: 'a0',
        parentId: `${prefix}-frame`,
        locked: false,
        params: { prompt: 'first' },
      },
    ],
    edges: [
      { id: `${prefix}-edge`, from: [`${prefix}-frame`, 'out'], to: [`${prefix}-node`, 'in'] },
    ],
  }
}

test('fixture hashes distinguish equal-length content and normalize only object key ordering', () => {
  expect(fixtureContentHash({ text: 'first' })).not.toBe(fixtureContentHash({ text: 'other' }))
  expect(fixtureContentHash({ x: 1, y: [2, 3] })).toBe(fixtureContentHash({ y: [2, 3], x: 1 }))
  expect(fixtureContentHash([1, 2])).not.toBe(fixtureContentHash([2, 1]))
})

test('demo hashes ignore random IDs and run state while retaining actual geometry and graph data', () => {
  const first = demo('first')
  const second = demo('different')
  second.elements[1]!.run = { id: 'random-run', status: 'queued', at: 12345 }
  expect(demoContentHash(first)).toBe(demoContentHash(second))
  second.elements[1]!.x++
  expect(demoContentHash(first)).not.toBe(demoContentHash(second))
  second.elements[1]!.x--
  second.elements[1]!.params!.prompt = 'other'
  expect(demoContentHash(first)).not.toBe(demoContentHash(second))
  second.elements[1]!.params!.prompt = 'first'
  second.edges[0]!.to[1] = 'another-port'
  expect(demoContentHash(first)).not.toBe(demoContentHash(second))
  second.edges[0]!.to[0] = 'missing'
  expect(() => demoContentHash(second)).toThrow(/missing element/)
})

test('accepts observed GPU names while preserving software-mode comparisons', () => {
  for (const renderer of [
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080, OpenGL 4.5)',
    'Mesa Intel(R) UHD Graphics 620',
  ]) {
    const baseline = report()
    const current = report()
    for (const value of [baseline, current]) {
      value.environment.renderer = renderer
      value.environment.renderMode = 'hardware'
    }
    expect(comparePerfReports(current, baseline)).toEqual([])
  }
})
