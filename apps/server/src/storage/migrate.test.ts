import Database from 'better-sqlite3'
import { describe, expect, it } from 'vite-plus/test'
import { wrapDb } from './db'
import { LEGACY_MIGRATIONS } from './legacy-migrations'
import { migrate } from './migrate'
import { MIGRATIONS } from './migrations.gen'
import { user } from './schema'

/** 每张表的列（名、类型、非空、默认值、主键）和索引名，用来比对两个库的结构 */
function shape(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
    )
    .all() as Array<{ name: string }>
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      {
        // 主键列的 NOT NULL：老库手写的 TEXT PRIMARY KEY 没写，Drizzle 会写上，不算差异
        columns: (
          db
            .prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`)
            .all(name) as Array<{ type: string; notnull: number; pk: number }>
        ).map((c) => ({ ...c, type: c.type.toLowerCase(), notnull: c.pk ? 1 : c.notnull })),
        foreignKeys: db
          .prepare('SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?)')
          .all(name),
        indexes: (
          db
            .prepare("SELECT name FROM pragma_index_list(?) WHERE origin = 'c' ORDER BY name")
            .all(name) as Array<{ name: string }>
        ).map((i) => i.name),
      },
    ]),
  )
}

/** 改用 Drizzle 前的库：手写迁移到最后一版，加上 Better Auth 自带迁移建的认证表 */
function legacyDb() {
  const db = new Database(':memory:')
  for (const m of LEGACY_MIGRATIONS) db.exec(m)
  db.pragma(`user_version = ${LEGACY_MIGRATIONS.length}`)
  db.exec(`
    CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
    CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
    CREATE INDEX "session_userId_idx" on "session" ("userId");
    CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
    CREATE INDEX "account_userId_idx" on "account" ("userId");
    CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
    CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");
  `)
  return db
}

describe('数据库迁移', () => {
  it('新库按 Drizzle 迁移建好，重复执行不出错', () => {
    const db = new Database(':memory:')
    migrate(db)
    migrate(db)
    const done = db.prepare('SELECT hash FROM __drizzle_migrations').all()
    expect(done).toHaveLength(MIGRATIONS.length)
    db.close()
  })

  it('改用 Drizzle 前的库接上迁移后，表结构与新库一致', () => {
    const fresh = new Database(':memory:')
    migrate(fresh)
    const old = legacyDb()
    migrate(old)
    // 基线记为已执行
    expect(old.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: MIGRATIONS.length,
    })
    const a = shape(old)
    const b = shape(fresh)
    expect(Object.keys(a)).toEqual(Object.keys(b))
    for (const t of Object.keys(b)) {
      expect(a[t]!.columns, t).toEqual(b[t]!.columns)
      expect(a[t]!.foreignKeys, t).toEqual(b[t]!.foreignKeys)
      // 老库用内联 UNIQUE（自动索引），新库是具名唯一索引：只比非自动建的普通索引里老库已有的
      for (const i of a[t]!.indexes) expect(b[t]!.indexes, t).toContain(i)
    }
    fresh.close()
    old.close()
  })

  it('旧画布各自变成同名项目', () => {
    const db = new Database(':memory:')
    // 先迁到加项目之前的版本，插一张旧画布，再迁到最新
    for (const m of LEGACY_MIGRATIONS.slice(0, 4)) db.exec(m)
    db.prepare('INSERT INTO canvases VALUES (?, ?, ?, ?, ?)').run('cv_old', 'local', '老画布', 1, 2)
    db.pragma('user_version = 4')
    migrate(db)
    expect(db.prepare('SELECT project_id FROM canvases').get()).toEqual({ project_id: 'pj_cv_old' })
    expect(db.prepare('SELECT id, title, owner_id FROM projects').get()).toEqual({
      id: 'pj_cv_old',
      title: '老画布',
      owner_id: 'local',
    })
    db.close()
  })

  it('Better Auth 旧数据（ISO 时间、0/1 布尔）经 Drizzle 读写正常', () => {
    const sqlite = legacyDb()
    sqlite
      .prepare('INSERT INTO "user" VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('u1', '所有者', 'a@b.c', 0, null, '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z')
    const db = wrapDb(sqlite)
    const row = db.select().from(user).get()!
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.createdAt.toISOString()).toBe('2026-10-01T08:00:00.000Z')
    expect(row.emailVerified).toBe(false)
    db.insert(user)
      .values({
        id: 'u2',
        name: '新',
        email: 'd@e.f',
        emailVerified: true,
        createdAt: new Date('2026-10-12T00:00:00Z'),
        updatedAt: new Date('2026-10-12T00:00:00Z'),
      })
      .run()
    expect(
      sqlite.prepare('SELECT createdAt, emailVerified FROM "user" WHERE id = ?').get('u2'),
    ).toEqual({
      createdAt: '2026-10-12T00:00:00.000Z',
      emailVerified: 1,
    })
    sqlite.close()
  })

  it('数据库被更新版本迁移过时拒绝启动', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(
      'future',
      MIGRATIONS.at(-1)!.when + 1,
    )
    expect(() => migrate(db)).toThrow('请升级 plein')
    db.close()
  })
})
