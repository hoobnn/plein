import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from './migrate'
import * as schema from './schema'

/** Drizzle 实例；底层的 better-sqlite3 连接在 db.$client */
export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database }
/** 事务里的连接，和 DB 一样能读写 */
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]
/** 既能在事务外也能在事务里调用的函数用它 */
export type Conn = DB | Tx

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true })
  return wrapDb(new Database(join(dataDir, 'plein.db')))
}

/** 给现成的连接（测试里的内存库）设好 pragma、跑迁移，包成 Drizzle 实例 */
export function wrapDb(sqlite: Database.Database): DB {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  migrate(sqlite)
  return drizzle({ client: sqlite, schema })
}
