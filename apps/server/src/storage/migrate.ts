import type Database from 'better-sqlite3'
import { LEGACY_MIGRATIONS } from './legacy-migrations'
import { MIGRATIONS } from './migrations.gen'

/** drizzle-kit 生成的一个迁移（内嵌在 migrations.gen.ts） */
export interface Migration {
  tag: string
  /** 生成时间，也是迁移表里的 created_at，按它判断哪些已经跑过 */
  when: number
  hash: string
  statements: string[]
}

/** 与 drizzle-orm 自带迁移器同一张表、同样的记录方式，drizzle-kit migrate 也认得 */
const TABLE = '__drizzle_migrations'

function ensureTable(db: Database.Database) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)`,
  )
}

function hasTable(db: Database.Database, name: string) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  )
}

/**
 * 改用 Drizzle 之前的数据库（user_version > 0，没有迁移表）：先补完手写迁移，
 * 再把基线迁移按“已存在就跳过”执行一遍（补上可能缺的认证表和索引），记为已执行。
 */
function upgradeLegacy(db: Database.Database, migrations: Migration[]) {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version === 0 || hasTable(db, TABLE)) return
  if (version > LEGACY_MIGRATIONS.length) {
    throw new Error(
      `数据库版本 ${version} 高于当前程序支持的 ${LEGACY_MIGRATIONS.length}，请升级 plein`,
    )
  }
  const baseline = migrations[0]!
  db.transaction(() => {
    for (let v = version; v < LEGACY_MIGRATIONS.length; v++) db.exec(LEGACY_MIGRATIONS[v]!)
    db.pragma(`user_version = ${LEGACY_MIGRATIONS.length}`)
    for (const stmt of baseline.statements) {
      db.exec(
        stmt
          .replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')
          .replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS '),
      )
    }
    ensureTable(db)
    db.prepare(`INSERT INTO ${TABLE} (hash, created_at) VALUES (?, ?)`).run(
      baseline.hash,
      baseline.when,
    )
  })()
}

/** 按顺序执行还没跑过的迁移，每个迁移一个事务 */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS) {
  upgradeLegacy(db, migrations)
  ensureTable(db)
  const last = db.prepare(`SELECT MAX(created_at) AS at FROM ${TABLE}`).get() as {
    at: number | null
  }
  const latest = migrations.at(-1)?.when ?? 0
  if (last.at !== null && last.at > latest) {
    throw new Error('数据库由更新版本的 plein 迁移过，请升级 plein')
  }
  for (const m of migrations) {
    if (last.at !== null && m.when <= last.at) continue
    db.transaction(() => {
      for (const stmt of m.statements) db.exec(stmt)
      db.prepare(`INSERT INTO ${TABLE} (hash, created_at) VALUES (?, ?)`).run(m.hash, m.when)
    })()
  }
}
