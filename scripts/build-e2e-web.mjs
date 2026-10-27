/**
 * e2e 前端构建的缓存包装：源码没变就不重建。
 *
 * 每次 `pnpm e2e` 都重建 dist-e2e 的话，改一条用例也要等一次完整构建。
 * 这里按构建输入（apps/web 与 packages 下的源码、配置、锁文件）算哈希，
 * 哈希一样就直接复用上次的产物。
 *
 * 用法：
 *   node scripts/build-e2e-web.mjs          # 需要时构建
 *   node scripts/build-e2e-web.mjs --force  # 强制重建
 *   PLEIN_E2E_BUILD=0 node scripts/...      # 完全跳过构建
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'apps/web/dist-e2e')
const stampFile = join(root, 'apps/web/.e2e-build-stamp.json')
/** 标记里记相对路径，换个检出目录也不会失效 */
const outDirRelative = 'apps/web/dist-e2e'

/** 构建输入的目录：前端源码和它依赖的公共包 */
const INPUT_DIRS = ['apps/web/src', 'apps/web/public', 'packages']
/** 构建输入的文件：配置和锁文件 */
const INPUT_FILES = [
  'apps/web/package.json',
  'apps/web/vite.config.ts',
  'apps/web/tsconfig.json',
  'apps/web/index.html',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]

/** 不参与哈希的目录：产物和缓存本身 */
const SKIP = new Set(['node_modules', 'dist', 'dist-e2e', '.git', 'coverage', 'test-results'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** 按内容算哈希：文件路径 + 内容，顺序固定 */
function hashInputs() {
  const hash = createHash('sha256')
  const files = []
  for (const dir of INPUT_DIRS) {
    const path = join(root, dir)
    if (existsSync(path)) files.push(...walk(path))
  }
  for (const file of INPUT_FILES) {
    const path = join(root, file)
    if (existsSync(path)) files.push(path)
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const file of files) {
    hash.update(relative(root, file))
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    return null
  }
}

const force = process.argv.includes('--force')
if (process.env.PLEIN_E2E_BUILD === '0') {
  console.log('PLEIN_E2E_BUILD=0：跳过前端构建')
  process.exit(0)
}

const hash = hashInputs()
const stamp = readStamp()
const fresh =
  !force &&
  stamp?.hash === hash &&
  stamp?.outDir === outDirRelative &&
  existsSync(join(outDir, 'index.html'))
if (fresh) {
  console.log('前端 e2e 构建未变化，复用现有 dist-e2e')
  process.exit(0)
}

console.log(force ? '强制重建前端 e2e 产物' : '前端 e2e 源码有变化，重新构建')
const result = spawnSync(
  'pnpm',
  ['--filter', '@plein/web', 'exec', 'vp', 'build', '--mode', 'e2e', '--outDir', 'dist-e2e'],
  { cwd: root, stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status ?? 1)

writeFileSync(
  stampFile,
  JSON.stringify({ hash, outDir: outDirRelative, at: new Date().toISOString() }, null, 2) + '\n',
)
