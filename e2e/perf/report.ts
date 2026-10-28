export const PERF_FORMAT_VERSION = 3
export const PERF_SCENARIO_NAMES = [
  '平移',
  '缩放',
  '平移（选中素材，浮动工具条跟随）',
  '拖动 12 个元素',
  '静止（20 个节点生成中）',
] as const
export const EXPECTED_METRIC_KEYS: readonly string[] = [
  'cold.engineReadyMs',
  'cold.firstVisiblePreviewMs',
  'cold.visibleMediaSettledMs',
  'warm.engineReadyMs',
  'warm.firstVisiblePreviewMs',
  'warm.visibleMediaSettledMs',
  'markdown.retainedBytes',
  'session.retainedBytes',
  ...PERF_SCENARIO_NAMES.map((name) => `${name}.jsMs`),
]

export interface PerfReport {
  formatVersion: typeof PERF_FORMAT_VERSION
  status: 'complete' | 'failed'
  buildFingerprint: string
  sourceCommit: string
  sourceDirty: boolean
  measuredAt: string
  environment: {
    runtime: string
    platform: string
    browserVersion: string
    browserKind: string
    renderer: string
    renderMode: string
    viewport: { width: number; height: number }
  }
  fixture: {
    version: number
    elements: number
    imageAssets: number
    videoAssets: number
    audioAssets: number
    serializedBytes: number
    contentHash: string
    demoContentHash: string
    sessionIterations: number
    /** v3 早期报告省略此字段，等价于每帧一个步骤。 */
    sessionStepsPerFrame?: number
  }
  rounds: number
  metrics: Record<string, number>
  /** Raw observations in measurement order, before taking each metric's median. */
  samples: Record<string, number[]>
  details: unknown
}

export interface PerfRegression {
  metric: string
  baseline: number
  current: number
}

/** Requested hardware mode must be backed by an identifiable GPU, not a fallback. */
export function assertRendererMode(mode: string, renderer: string) {
  if (mode !== 'hardware') return
  if (
    /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(renderer) ||
    !/apple|nvidia|amd|radeon|intel|adreno|mali|powervr|vivante|qualcomm/i.test(renderer)
  )
    throw new Error(`Hardware renderer could not be verified: ${renderer}`)
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function medianSample(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0
const expectedKeys = canonical([...EXPECTED_METRIC_KEYS].sort())

/** Validate persisted JSON as well as in-memory reports; partial suites cannot pass the gate. */
export function assertCompletePerfReport(value: unknown): asserts value is PerfReport {
  if (!record(value) || value.status !== 'complete')
    throw new Error('A failed or incomplete performance report cannot be compared')
  if (value.formatVersion !== PERF_FORMAT_VERSION)
    throw new Error('Unsupported performance report formatVersion')
  if (
    !nonempty(value.sourceCommit) ||
    typeof value.sourceDirty !== 'boolean' ||
    !nonempty(value.measuredAt) ||
    !Number.isFinite(Date.parse(value.measuredAt)) ||
    !hash(value.buildFingerprint)
  )
    throw new Error('Invalid performance report provenance')
  const env = value.environment
  if (
    !record(env) ||
    !['runtime', 'platform', 'browserVersion', 'renderer'].every((key) => nonempty(env[key])) ||
    env.renderer === 'unobserved' ||
    (env.renderMode !== 'software' && env.renderMode !== 'hardware') ||
    !['chromium', 'headless-shell'].includes(String(env.browserKind)) ||
    !record(env.viewport) ||
    !positiveInteger(env.viewport.width) ||
    !positiveInteger(env.viewport.height)
  )
    throw new Error('Invalid performance execution environment')
  assertRendererMode(env.renderMode, env.renderer as string)
  const fixture = value.fixture
  if (
    !record(fixture) ||
    !positiveInteger(fixture.version) ||
    !positiveInteger(fixture.elements) ||
    !positiveInteger(fixture.imageAssets) ||
    !['videoAssets', 'audioAssets'].every(
      (key) => Number.isSafeInteger(fixture[key]) && nonnegative(fixture[key]),
    ) ||
    !positiveInteger(fixture.serializedBytes) ||
    !positiveInteger(fixture.sessionIterations) ||
    (fixture.sessionStepsPerFrame !== undefined &&
      ![1, 2, 3, 4, 5].includes(fixture.sessionStepsPerFrame as number)) ||
    !hash(fixture.contentHash) ||
    !hash(fixture.demoContentHash)
  )
    throw new Error('Invalid performance fixture or content hash')
  if (!positiveInteger(value.rounds) || (value.rounds as number) < 3)
    throw new Error('Performance comparisons require at least three rounds')
  if (
    !record(value.metrics) ||
    !record(value.samples) ||
    canonical(Object.keys(value.metrics).sort()) !== expectedKeys ||
    canonical(Object.keys(value.samples).sort()) !== expectedKeys
  )
    throw new Error('Performance report must contain the complete metric/scenario set and samples')
  for (const metric of EXPECTED_METRIC_KEYS) {
    const samples = value.samples[metric]
    const measurement = value.metrics[metric]
    if (
      !nonnegative(measurement) ||
      !Array.isArray(samples) ||
      samples.length !== value.rounds ||
      ![...samples].every(nonnegative)
    )
      throw new Error(`Invalid performance measurement or round samples: ${metric}`)
    if (medianSample(samples) !== measurement)
      throw new Error(`Performance measurement does not match sample median: ${metric}`)
  }
}

/** Both the relative and absolute slowdown must exceed the gate. */
export function comparePerfReports(current: PerfReport, baseline: PerfReport): PerfRegression[] {
  assertCompletePerfReport(current)
  assertCompletePerfReport(baseline)
  if (
    baseline.formatVersion !== current.formatVersion ||
    canonical(baseline.environment) !== canonical(current.environment) ||
    canonical({
      ...baseline.fixture,
      sessionStepsPerFrame: baseline.fixture.sessionStepsPerFrame ?? 1,
    }) !==
      canonical({
        ...current.fixture,
        sessionStepsPerFrame: current.fixture.sessionStepsPerFrame ?? 1,
      })
  )
    throw new Error(
      'Performance baseline fixture, runtime, browser, renderer or platform does not match',
    )
  if (current.rounds !== baseline.rounds)
    throw new Error(
      'Performance comparisons require the same sample count and at least three rounds',
    )
  const regressions: PerfRegression[] = []
  for (const metric of EXPECTED_METRIC_KEYS) {
    const before = baseline.metrics[metric]!
    const after = current.metrics[metric]!
    if (!Number.isFinite(before) || before < 0 || !Number.isFinite(after) || after < 0)
      throw new Error(`Invalid performance measurement: ${metric}`)
    const absolute = metric.endsWith('.retainedBytes')
      ? 2 * 1024 * 1024
      : metric.endsWith('.jsMs')
        ? 2
        : metric.endsWith('.visibleMediaSettledMs')
          ? 200
          : 100
    if (after > before * 1.5 && after - before > absolute)
      regressions.push({ metric, baseline: before, current: after })
  }
  return regressions
}
