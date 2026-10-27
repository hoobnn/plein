/**
 * 统计 Playwright JSON 报告的耗时：按文件和按用例排序，找出最慢的用例。
 * 用法：node scripts/e2e-timing.mjs <报告.json> [最慢的条数]
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const limit = Number(process.argv[3] ?? 30)
if (!file) {
  console.error('用法：node scripts/e2e-timing.mjs <报告.json> [条数]')
  process.exit(1)
}
const report = JSON.parse(readFileSync(file, 'utf8'))

/** 摊平套件树，收集每个用例的耗时 */
const rows = []
let total = 0
const walk = (suite, fileOfSuite = '') => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const duration = test.results?.reduce((max, r) => Math.max(max, r.duration ?? 0), 0) ?? 0
      const file = spec.file ?? fileOfSuite
      const title = [spec.title, ...(test.title !== spec.title ? [test.title] : [])]
        .filter(Boolean)
        .join(' › ')
      rows.push({ file, title, duration, status: test.status ?? 'unknown' })
      total += duration
    }
  }
  for (const child of suite.suites ?? []) walk(child, fileOfSuite)
}
for (const suite of report.suites ?? []) walk(suite)

// 用例耗时是串行执行的累计值；套件的总耗时还要算上钩子和等待
const byFile = new Map()
for (const row of rows) byFile.set(row.file, (byFile.get(row.file) ?? 0) + row.duration)

console.log(`总用例数：${rows.length}`)
console.log(`用例耗时合计：${(total / 1000).toFixed(1)}s`)
console.log(`报告总时长：${((report.stats?.duration ?? 0) / 1000).toFixed(1)}s`)
console.log('')
console.log(`=== 最慢的 ${limit} 个文件 ===`)
const files = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
for (const [file, duration] of files)
  console.log(`${(duration / 1000).toFixed(1).padStart(7)}s  ${file}`)
console.log('')
console.log(`=== 最慢的 ${limit} 条用例 ===`)
for (const row of rows.sort((a, b) => b.duration - a.duration).slice(0, limit))
  console.log(`${(row.duration / 1000).toFixed(1).padStart(7)}s  ${row.file} :: ${row.title}`)

const failures = rows.filter((r) => r.status === 'unexpected')
console.log('')
console.log(`=== 失败 ${failures.length} 条 ===`)
for (const row of failures.slice(0, 40)) console.log(`${row.file} :: ${row.title}`)
