/** 同一 harness、浏览器与 runner，顺序测量独立检出的基线和候选版本。 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { assertCompletePerfReport, comparePerfReports } from './report'

const HARNESS_ROOT = resolve(import.meta.dirname, '../..')
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

export function selectBaseline(root: string, baselineRoot: string, requestedRef?: string) {
  if (realpathSync(root) === realpathSync(baselineRoot))
    throw new Error('PERF_BASE_ROOT must be an independent checkout')
  const selectedRef =
    requestedRef || git(root, 'describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', 'HEAD^')
  const baselineCommit = git(
    root,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${selectedRef}^{commit}`,
  )
  const candidateCommit = git(root, 'rev-parse', 'HEAD')
  if (baselineCommit === candidateCommit)
    throw new Error('Performance baseline and candidate must be different commits')
  if (git(baselineRoot, 'rev-parse', 'HEAD') !== baselineCommit)
    throw new Error(`PERF_BASE_ROOT does not match the selected baseline: ${selectedRef}`)
  if (git(baselineRoot, 'status', '--porcelain'))
    throw new Error('Performance baseline checkout must be clean')
  return {
    selectedRef,
    selection: requestedRef ? 'explicit-ref' : 'nearest-ancestor-version-tag',
    baselineCommit,
    candidateCommit,
  }
}

export function compareReportFiles(baselinePath: string, candidatePath: string) {
  const baseline: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const candidate: unknown = JSON.parse(readFileSync(candidatePath, 'utf8'))
  assertCompletePerfReport(baseline)
  assertCompletePerfReport(candidate)
  return { baseline, candidate, regressions: comparePerfReports(candidate, baseline) }
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    // 让 bench 有机会关闭浏览器和后端，再由它删除本轮数据目录。
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const done = (error?: Error) => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      if (error) reject(error)
      else resolveRun()
    }
    child.once('error', done)
    child.once('exit', (code, signal) =>
      done(
        code === 0
          ? undefined
          : new Error(`${command} failed (${signal ?? code}); comparison was not completed`),
      ),
    )
  })
}

async function measureBoth() {
  const root = resolve(process.env.PERF_ROOT ?? HARNESS_ROOT)
  if (!process.env.PERF_BASE_ROOT)
    throw new Error(
      'PERF_BASE_ROOT is required; prepare a clean checkout with its locked dependencies first',
    )
  const baselineRoot = resolve(process.env.PERF_BASE_ROOT)
  const selection = selectBaseline(root, baselineRoot, process.env.PERF_BASE_REF)
  const output = resolve(
    process.env.PERF_COMPARE_OUTPUT ?? join(root, 'test-results/perf-comparison'),
  )
  mkdirSync(output, { recursive: true })
  const baselinePath = join(output, 'baseline.json')
  const candidatePath = join(output, 'candidate.json')
  const summaryPath = join(output, 'comparison.json')
  const manifest = {
    ...selection,
    harnessCommit: git(HARNESS_ROOT, 'rev-parse', 'HEAD'),
    harnessDirty: !!git(HARNESS_ROOT, 'status', '--porcelain'),
    measuredAt: new Date().toISOString(),
  }
  try {
    // 诊断开关不能悄悄把 A/B 门禁变成场景子集；两边使用同一 Chromium 二进制。
    const env = { ...process.env }
    for (const key of [
      'PERF_PROFILE',
      'PERF_SKIP_OPEN',
      'PERF_SCENARIOS',
      'PERF_DIST',
      'PERF_BASELINE',
      'PERF_OUTPUT',
    ])
      delete env[key]
    env.PERF_CHROMIUM = process.env.PERF_CHROMIUM ?? chromium.executablePath()
    const loader = createRequire(join(HARNESS_ROOT, 'apps/server/package.json')).resolve('tsx')
    for (const [target, reportPath] of [
      [baselineRoot, baselinePath],
      [root, candidatePath],
    ] as const) {
      console.log(`[perf] measuring ${target}`)
      await run(
        join(target, 'node_modules/.bin/vp'),
        ['build', '--mode', 'e2e', '--outDir', 'dist-e2e'],
        join(target, 'apps/web'),
        env,
      )
      await run(
        process.execPath,
        ['--import', loader, join(HARNESS_ROOT, 'e2e/perf/bench.ts')],
        join(HARNESS_ROOT, 'apps/server'),
        {
          ...env,
          PERF_ROOT: target,
          PERF_OUTPUT: reportPath,
        },
      )
    }
    const { baseline, candidate, regressions } = compareReportFiles(baselinePath, candidatePath)
    if (
      baseline.sourceCommit !== selection.baselineCommit ||
      candidate.sourceCommit !== selection.candidateCommit ||
      baseline.sourceDirty
    )
      throw new Error(
        'Measured source does not match the selected clean baseline / candidate commits',
      )
    const result = {
      ...manifest,
      status: regressions.length ? 'regressed' : 'passed',
      baselineCompared: true,
      regressions,
    }
    writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
    if (regressions.length) process.exitCode = 1
  } catch (error) {
    writeFileSync(
      summaryPath,
      `${JSON.stringify({ ...manifest, status: 'failed', baselineCompared: false, error: String(error) }, null, 2)}\n`,
    )
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--reports') {
      if (process.argv.length !== 5)
        throw new Error('Usage: compare.ts --reports baseline.json candidate.json')
      const { regressions } = compareReportFiles(
        resolve(process.argv[3]!),
        resolve(process.argv[4]!),
      )
      console.log(JSON.stringify({ baselineCompared: true, regressions }, null, 2))
      if (regressions.length) process.exitCode = 1
    } else await measureBoth()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
