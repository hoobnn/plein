import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vite-plus/test'

/**
 * 数据访问约定：路由文件里不直接写库。
 * Drizzle 查询放在存储模块（store.ts / *-store.ts / storage/ 目录），
 * 路由只调存储函数——见 CONTRIBUTING.md 的「结构调整约定 › 数据访问」。
 */

/** 服务端源码根目录 */
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * 暂时收不了的路由写在这里，并写明理由。
 * 空表：当前所有路由都不直接碰数据库，不需要例外。
 */
const ALLOWED: Record<string, string> = {}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
    if (!/\.[jt]sx?$/.test(entry.name)) return []
    if (/\.d\.ts$|\.(?:test|spec)\.[^.]+$/.test(entry.name)) return []
    return [path]
  })
}

/** 路由文件：routes.ts 与 *-routes.ts（cap-routes、package-routes 等） */
function routeFiles(directory: string): string[] {
  return sourceFiles(directory).filter((file) => file.endsWith('routes.ts'))
}

/** 直接 import Drizzle：说明这个文件自己在拼查询 */
const DRIZZLE_IMPORT = /from\s+['"]drizzle-orm/

/** 直接写库：db.insert / db.update / db.delete，事务里的 tx. 同理 */
const DRIZZLE_WRITE = /\b(?:db|tx)\s*\.\s*(?:insert|update|delete)\b/g

it('路由文件里不直接写库', () => {
  const violations = routeFiles(SOURCE_ROOT).flatMap((file) => {
    const key = relative(SOURCE_ROOT, file)
    if (ALLOWED[key]) return []
    const source = readFileSync(file, 'utf8')
    const found: string[] = []
    if (DRIZZLE_IMPORT.test(source)) found.push(`${key}：从 drizzle-orm import`)
    for (const match of source.matchAll(DRIZZLE_WRITE)) {
      const line = source.slice(0, match.index).split('\n').length
      found.push(`${key}:${line} ${match[0].replace(/\s+/g, ' ')}`)
    }
    return found
  })
  expect(
    violations,
    '路由文件里不直接写库：Drizzle 查询放进存储模块（store.ts / *-store.ts / storage/），' +
      '路由只调存储函数。确需例外时写进本文件的 ALLOWED 并写明理由。见 CONTRIBUTING.md「结构调整约定 › 数据访问」。',
  ).toEqual([])
})
