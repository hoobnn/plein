import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export type DB = Database.Database

/** 顺序执行的 schema 迁移，版本号记在 PRAGMA user_version */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE canvases (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX canvases_owner ON canvases(owner_id, updated_at);

  -- Yjs 增量更新，按 id 顺序重放；定期合并成一条
  CREATE TABLE doc_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX doc_updates_canvas ON doc_updates(canvas_id, id);

  -- 资产内容按哈希共享存储，元数据按所有者各一行
  CREATE TABLE assets (
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    variants TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, id)
  );
  `,
]

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'plein.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    throw new Error(`数据库版本 ${current} 高于当前程序支持的 ${MIGRATIONS.length}，请升级 plein`)
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
