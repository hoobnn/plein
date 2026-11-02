import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vite-plus/test'

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))
/** 原生控件确需保留时，按相对 src 的路径登记并写明理由。 */
const ALLOWED: Record<string, string> = {}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    if (!entry.name.endsWith('.tsx') || /\.(?:test|spec)\.[^.]+$/.test(entry.name)) return []
    return [path]
  })
}

it('原生下拉与滑块统一使用 Nova 控件', () => {
  const violations = sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const path = relative(SOURCE_ROOT, file)
    if (ALLOWED[path]) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(/<select\b|type\s*=\s*["']range["']/g)].map((match) => {
      const line = source.slice(0, match.index).split('\n').length
      return `${path}:${line} ${match[0]}`
    })
  })
  expect(
    violations,
    '请使用 ui/Select 或 ui/Slider，见 docs/dev/design-spec.md「通用控件」；例外须在 ALLOWED 登记路径与理由',
  ).toEqual([])
})
