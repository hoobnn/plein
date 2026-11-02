import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

/**
 * 数据访问约定：路由文件里不直接写库。
 * Drizzle 查询放在存储模块（store.ts / *-store.ts / storage/ 目录），
 * 路由只调存储函数——见 CONTRIBUTING.md 的「结构调整约定 › 数据访问」。
 *
 * 直连不只等于写：查询、原始 SQL、预编译语句、事务边界都算，
 * 因为它们都要求路由自己知道表结构，换传输层时同样要重写一遍。
 */

/** 服务端源码根目录 */
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * 暂时收不了的路由写在这里，并写明理由。
 * 空表：当前所有路由都不直接碰数据库，不需要例外。
 */
const ALLOWED: Record<string, string> = {}

/**
 * 数据库入口：db./tx. 后接这些就是在直接碰库。
 * 读操作同样算——`db.select` 与 `db.insert` 一样把表结构漏进了路由。
 */
const DB_ENTRIES = [
  'query', // 关系查询：db.query.projects.findMany()
  'run', // 原始 SQL：db.run('DELETE FROM ...')
  'all', // 原始 SQL 取多行
  'get', // 原始 SQL 取一行
  'values', // 原始 SQL 取多列
  'execute', // 原始 SQL 执行
  'prepare', // 预编译语句
  'transaction', // 事务边界
  'select', // 查询构造
  'insert', // 写入构造
  'update',
  'delete',
  '\\$client', // 底层连接：db.$client.prepare(...)
].join('|')

/**
 * 只认 db、tx 这两个接收者。
 * `assets.activity.run()` 这类同名方法在别的接收者上，是正常业务调用，不算直连。
 */
const DB_DIRECT = new RegExp(`(?<![\\w$])(?:db|tx)\\s*\\.\\s*(${DB_ENTRIES})(?![\\w$])`, 'g')

/** 直接 import Drizzle：说明这个文件自己在拼查询 */
const DRIZZLE_IMPORT = /from\s+['"]drizzle-orm/

/** 一处数据库直连 */
export interface DbDirect {
  /** 从 1 起的行号 */
  line: number
  /** 命中的写法 */
  text: string
}

/**
 * 找出一段源码里直连数据库的写法。
 * 纯函数：只读传入的源码，不碰文件系统。
 */
export function findDbDirect(source: string): DbDirect[] {
  const found: DbDirect[] = []
  for (const match of source.matchAll(DB_DIRECT)) {
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      text: match[0].replace(/\s+/g, ' '),
    })
  }
  return found
}

/**
 * 这段源码是否直接从 drizzle-orm 导入。
 * 纯函数：只读传入的源码，不碰文件系统。
 */
export function importsDrizzle(source: string): boolean {
  return DRIZZLE_IMPORT.test(source)
}

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

describe('数据库直连的检测', () => {
  it('认出 db./tx. 上的各种数据库入口', () => {
    const source = [
      "import { eq } from 'drizzle-orm'",
      'db.insert(templates).values({}).run()',
      'db.update(canvases).set({ title }).run()',
      'db.delete(templates).run()',
      'db.select(canvasColumns).from(canvases)',
      'db.query.projects.findMany()',
      "db.run('DELETE FROM templates')",
      "db.$client.prepare('DELETE FROM templates').run()",
      "db.all('SELECT 1')",
      "db.get('SELECT 1')",
      "db.values('SELECT 1')",
      "db.execute('SELECT 1')",
      'db.transaction((tx) => tx.insert(jobs))',
    ].join('\n')
    expect(importsDrizzle(source)).toBe(true)
    expect(findDbDirect(source).map((hit) => hit.text)).toEqual([
      'db.insert',
      'db.update',
      'db.delete',
      'db.select',
      'db.query',
      'db.run',
      'db.$client',
      'db.all',
      'db.get',
      'db.values',
      'db.execute',
      'db.transaction',
      'tx.insert',
    ])
  })

  it('别的接收者上的同名方法不算直连', () => {
    const source = [
      'assets.activity.run(async () => save())',
      'listCanvases(db, owner, projectId)',
      'app.get("/api/projects", handler)',
      'agents.get(id)',
      'req.query("projectId")',
      'await Promise.all([one(), two()])',
      'voices.update(id, patch)',
      'store.get(key)',
    ].join('\n')
    expect(importsDrizzle(source)).toBe(false)
    expect(findDbDirect(source)).toEqual([])
  })

  it('行号从 1 起算', () => {
    const source = ['const a = 1', 'const b = 2', 'db.select(x)'].join('\n')
    expect(findDbDirect(source)).toEqual([{ line: 3, text: 'db.select' }])
  })
})

it('路由文件里不直接写库', () => {
  const violations = routeFiles(SOURCE_ROOT).flatMap((file) => {
    const key = relative(SOURCE_ROOT, file)
    if (ALLOWED[key]) return []
    const source = readFileSync(file, 'utf8')
    const found: string[] = []
    if (importsDrizzle(source)) found.push(`${key}：从 drizzle-orm import`)
    for (const hit of findDbDirect(source)) found.push(`${key}:${hit.line} ${hit.text}`)
    return found
  })
  expect(
    violations,
    '路由文件里不直接写库：Drizzle 查询放进存储模块（store.ts / *-store.ts / storage/），' +
      '路由只调存储函数。确需例外时写进本文件的 ALLOWED 并写明理由。见 CONTRIBUTING.md「结构调整约定 › 数据访问」。',
  ).toEqual([])
})
