export interface PerfReport {
  formatVersion: 1
  status?: 'complete' | 'failed'
  buildFingerprint?: string
  sourceCommit: string
  sourceDirty: boolean
  measuredAt: string
  environment: {
    runtime: string
    platform: string
    browserVersion: string
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
  }
  rounds: number
  metrics: Record<string, number>
  details: unknown
}

export interface PerfRegression {
  metric: string
  baseline: number
  current: number
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Both the relative and absolute slowdown must exceed the gate. */
export function comparePerfReports(current: PerfReport, baseline: PerfReport): PerfRegression[] {
  if (
    current.status === 'failed' ||
    baseline.status === 'failed' ||
    !current.metrics ||
    !baseline.metrics
  )
    throw new Error('A failed or incomplete performance report cannot be used as a baseline')
  if (
    baseline.formatVersion !== current.formatVersion ||
    canonical(baseline.environment) !== canonical(current.environment) ||
    canonical(baseline.fixture) !== canonical(current.fixture)
  )
    throw new Error(
      'Performance baseline fixture, runtime, browser, renderer or platform does not match',
    )
  if (
    !Number.isSafeInteger(current.rounds) ||
    current.rounds < 3 ||
    current.rounds !== baseline.rounds
  )
    throw new Error(
      'Performance comparisons require the same sample count and at least three rounds',
    )
  const keys = Object.keys(current.metrics).sort()
  if (canonical(keys) !== canonical(Object.keys(baseline.metrics).sort()))
    throw new Error('Performance baseline metric/scenario set does not match')
  const regressions: PerfRegression[] = []
  for (const metric of keys) {
    const before = baseline.metrics[metric]!
    const after = current.metrics[metric]!
    if (!Number.isFinite(before) || before < 0 || !Number.isFinite(after) || after < 0)
      throw new Error(`Invalid performance measurement: ${metric}`)
    const absolute = metric.endsWith('.jsMs')
      ? 2
      : metric.endsWith('.visibleMediaSettledMs')
        ? 200
        : 100
    if (after > before * 1.5 && after - before > absolute)
      regressions.push({ metric, baseline: before, current: after })
  }
  return regressions
}
