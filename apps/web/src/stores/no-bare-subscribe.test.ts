import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vite-plus/test'

const STORE_HOOKS = [
  'useAgent',
  'useCancelRequests',
  'useCanvas',
  'useCatalog',
  'useCheckpoints',
  'useContinueRequests',
  'useGroupRuns',
  'useLibrary',
  'useMediaLibrary',
  'useRecoveryRequests',
  'useRunRequests',
  'useSession',
  'useSidebar',
  'useStale',
  'useTemplates',
  'useTheme',
  'useUpdate',
]

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    if (!/\.[jt]sx?$/.test(entry.name)) return []
    if (/\.d\.ts$|\.(?:test|spec)\.[^.]+$/.test(entry.name)) return []
    return [path]
  })
}

it('Zustand store hook 不使用无参全量订阅', () => {
  const violations = sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    const bareSubscribe = new RegExp(`\\b(?:${STORE_HOOKS.join('|')})\\s*\\(\\s*\\)`, 'g')
    return [...source.matchAll(bareSubscribe)].map((match) => {
      const line = source.slice(0, match.index).split('\n').length
      return `${relative(SOURCE_ROOT, file)}:${line} ${match[0]}`
    })
  })
  expect(violations).toEqual([])
})
