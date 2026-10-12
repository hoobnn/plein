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
  `
  -- 用户存的模板（Frame 及其内容，JSON 同复制粘贴格式）
  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX templates_owner ON templates(owner_id, created_at);
  `,
  `
  -- 节点运行任务：id 即画布上节点的 run.id 和结果的 runId
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    group_id TEXT,
    node_type TEXT NOT NULL,
    -- queued | running | succeeded | failed | canceled
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    -- 节点类型、参数、输入的哈希；与当前算出的一致说明结果仍然有效
    cache_key TEXT,
    -- 由运行结果写回的参数（如分镜），算缓存键时不计入，JSON 数组
    cache_omit TEXT,
    -- 模型调用记录（见 CallJournal），重启后据此续跑
    calls TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX jobs_active ON jobs(status) WHERE status IN ('queued', 'running');
  CREATE INDEX jobs_node ON jobs(canvas_id, node_id, created_at);

  -- 整组运行（Frame）：服务端按依赖调度，重启后继续
  CREATE TABLE job_groups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    frame_id TEXT NOT NULL,
    options TEXT NOT NULL,
    targets TEXT NOT NULL,
    -- running | done | canceled
    status TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX job_groups_active ON job_groups(status) WHERE status = 'running';
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
