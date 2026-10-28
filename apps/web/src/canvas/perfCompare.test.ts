import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { selectBaseline } from '../../../../e2e/perf/compare'
import {
  assertCompletePerfReport,
  EXPECTED_METRIC_KEYS,
  PERF_FORMAT_VERSION,
  type PerfReport,
} from '../../../../e2e/perf/report'

const ROOT = resolve(import.meta.dirname, '../../../..')
const loader = createRequire(join(ROOT, 'apps/server/package.json')).resolve('tsx')
const temporary: string[] = []
// git 钩子里跑时会带上外层仓库的 GIT_DIR 等变量，临时仓库不能继承
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'])
  delete process.env[key]
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temp() {
  const path = mkdtempSync(join(tmpdir(), 'plein-perf-compare-'))
  temporary.push(path)
  return path
}

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  ).trim()
}

function repository() {
  const directory = temp()
  const root = join(directory, 'candidate')
  const baselineRoot = join(directory, 'baseline')
  mkdirSync(root)
  git(root, 'init', '--quiet', '--initial-branch=main')
  git(root, 'config', 'user.name', 'Performance Fixture')
  git(root, 'config', 'user.email', 'fixture@example.test')
  const commit = (version: string) => {
    writeFileSync(join(root, 'tracked.txt'), `${version}\n`)
    git(root, 'add', 'tracked.txt')
    git(root, 'commit', '--quiet', '-m', version)
    git(root, 'tag', version)
    return git(root, 'rev-parse', 'HEAD')
  }
  const oldest = commit('v1.0.0')
  const previous = commit('v1.1.0')
  const candidate = commit('v1.2.0')
  git(root, 'worktree', 'add', '--quiet', '--detach', baselineRoot, previous)
  return { directory, root, baselineRoot, oldest, previous, candidate }
}

describe('性能比较的基线选择', () => {
  it('默认取候选之前最近的版本 tag，即使候选本身已有新 tag', () => {
    const fixture = repository()
    expect(selectBaseline(fixture.root, fixture.baselineRoot)).toEqual({
      selectedRef: 'v1.1.0',
      selection: 'nearest-ancestor-version-tag',
      baselineCommit: fixture.previous,
      candidateCommit: fixture.candidate,
    })
  })

  it('显式 override 可选择更早的 tag 或 commit，而不偷偷改回默认基线', () => {
    const fixture = repository()
    git(fixture.baselineRoot, 'checkout', '--quiet', '--detach', fixture.oldest)
    for (const ref of ['v1.0.0', fixture.oldest]) {
      expect(selectBaseline(fixture.root, fixture.baselineRoot, ref)).toMatchObject({
        selectedRef: ref,
        selection: 'explicit-ref',
        baselineCommit: fixture.oldest,
        candidateCommit: fixture.candidate,
      })
    }
  })

  it('拒绝同一个 checkout，包括指向它的路径别名', () => {
    const fixture = repository()
    const alias = join(fixture.directory, 'candidate-alias')
    symlinkSync(fixture.root, alias, 'dir')
    for (const baselineRoot of [fixture.root, alias])
      expect(() => selectBaseline(fixture.root, baselineRoot)).toThrow(/independent checkout/)
  })

  it('不同 checkout 也不能拿候选的同一 commit 做基线', () => {
    const fixture = repository()
    git(fixture.baselineRoot, 'checkout', '--quiet', '--detach', fixture.candidate)
    expect(() => selectBaseline(fixture.root, fixture.baselineRoot, fixture.candidate)).toThrow(
      /different commits/,
    )
  })

  it('拒绝实际 checkout 与选定基线不符，不能只在报告里标成正确 tag', () => {
    const fixture = repository()
    git(fixture.baselineRoot, 'checkout', '--quiet', '--detach', fixture.oldest)
    expect(() => selectBaseline(fixture.root, fixture.baselineRoot)).toThrow(
      /does not match the selected baseline/,
    )
  })

  it.each(['tracked', 'untracked'] as const)('拒绝存在 %s 改动的基线', (kind) => {
    const fixture = repository()
    writeFileSync(
      join(fixture.baselineRoot, kind === 'tracked' ? 'tracked.txt' : 'untracked.txt'),
      'dirty baseline\n',
    )
    expect(() => selectBaseline(fixture.root, fixture.baselineRoot)).toThrow(/must be clean/)
  })
})

function report(sourceCommit: string): PerfReport {
  const value: PerfReport = {
    formatVersion: PERF_FORMAT_VERSION,
    status: 'complete',
    buildFingerprint: 'a'.repeat(64),
    sourceCommit,
    sourceDirty: false,
    measuredAt: '2026-10-23T00:00:00Z',
    environment: {
      runtime: 'node fixture',
      platform: 'test/test',
      browserVersion: 'Chromium fixture',
      browserKind: 'headless-shell',
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
      sessionIterations: 12,
    },
    rounds: 3,
    metrics: Object.fromEntries(EXPECTED_METRIC_KEYS.map((key) => [key, 1])),
    samples: Object.fromEntries(EXPECTED_METRIC_KEYS.map((key) => [key, [1, 1, 1]])),
    details: {},
  }
  assertCompletePerfReport(value)
  return value
}

function measurement(report: PerfReport, key: string, value: number) {
  report.metrics[key] = value
  report.samples[key] = Array.from({ length: report.rounds }, () => value)
}

function compare(baseline: PerfReport, candidate: PerfReport) {
  const directory = temp()
  const baselinePath = join(directory, 'baseline.json')
  const candidatePath = join(directory, 'candidate.json')
  writeFileSync(baselinePath, JSON.stringify(baseline))
  writeFileSync(candidatePath, JSON.stringify(candidate))
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loader,
      join(ROOT, 'e2e/perf/compare.ts'),
      '--reports',
      baselinePath,
      candidatePath,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 15_000 },
  )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return result
}

describe('性能比较命令的真实退出状态', () => {
  it('完整且可比较的报告返回 exit 0', () => {
    const result = compare(report('a'.repeat(40)), report('d'.repeat(40)))
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ baselineCompared: true, regressions: [] })
  })

  it('同时超过 50% 和绝对阈值的回退返回 exit 1，并列出命中的指标', () => {
    const baseline = report('a'.repeat(40))
    const candidate = report('d'.repeat(40))
    measurement(baseline, 'cold.firstVisiblePreviewMs', 200)
    measurement(candidate, 'cold.firstVisiblePreviewMs', 401)
    measurement(candidate, '平移.jsMs', 4)
    const result = compare(baseline, candidate)
    expect(result.status, result.stderr).toBe(1)
    expect(JSON.parse(result.stdout)).toEqual({
      baselineCompared: true,
      regressions: [
        { metric: 'cold.firstVisiblePreviewMs', baseline: 200, current: 401 },
        { metric: '平移.jsMs', baseline: 1, current: 4 },
      ],
    })
  })

  it.each(['markdown.retainedBytes', 'session.retainedBytes'])(
    'CI 节奏下 %s 回退仍返回 exit 1，阈值边界不变',
    (key) => {
      const baseline = report('a'.repeat(40))
      const candidate = report('d'.repeat(40))
      baseline.fixture.sessionStepsPerFrame = candidate.fixture.sessionStepsPerFrame = 5
      measurement(baseline, key, 1024 * 1024)
      measurement(candidate, key, 3 * 1024 * 1024)
      expect(compare(baseline, candidate).status).toBe(0)
      measurement(candidate, key, 3 * 1024 * 1024 + 1)
      const result = compare(baseline, candidate)
      expect(result.status, result.stderr).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({
        baselineCompared: true,
        regressions: [{ metric: key, baseline: 1024 * 1024, current: 3 * 1024 * 1024 + 1 }],
      })
    },
  )

  it.each(['missing-metric', 'missing-samples', 'missing-round'] as const)(
    '%s 报告返回 exit 1，不能将场景缺失算成无回退',
    (kind) => {
      const baseline = report('a'.repeat(40))
      const candidate = report('d'.repeat(40))
      const key = 'cold.firstVisiblePreviewMs'
      if (kind === 'missing-metric') delete candidate.metrics[key]
      else if (kind === 'missing-samples') delete candidate.samples[key]
      else candidate.samples[key] = [1, 1]
      const result = compare(baseline, candidate)
      expect(result.status, result.stdout).toBe(1)
      expect(result.stderr).toMatch(/complete metric\/scenario set|round samples/)
    },
  )

  it('两份报告的执行环境不同返回 exit 1', () => {
    const baseline = report('a'.repeat(40))
    const candidate = report('d'.repeat(40))
    candidate.environment.browserVersion = 'Chromium different fixture'
    const result = compare(baseline, candidate)
    expect(result.status, result.stdout).toBe(1)
    expect(result.stderr).toMatch(/does not match/)
  })
})
