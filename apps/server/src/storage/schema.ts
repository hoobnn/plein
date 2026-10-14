import type { AgentKind, AssetKind, JobStatus } from '@plein/protocol'
import { sql } from 'drizzle-orm'
import {
  blob,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core'

/**
 * 数据库 schema（Drizzle）。改了这里之后跑 `pnpm --filter @plein/server db:generate`
 * 生成迁移（apps/server/drizzle/）并更新内嵌的 storage/migrations.gen.ts，两者都要提交。
 * 表名、列名、索引名沿用 Drizzle 之前手写 SQL 的版本，老数据库不需要改结构。
 */

export const projects = sqliteTable(
  'projects',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    title: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index('projects_owner').on(t.owner_id, t.updated_at)],
)

export const canvases = sqliteTable(
  'canvases',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    title: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    project_id: text().references(() => projects.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('canvases_owner').on(t.owner_id, t.updated_at),
    index('canvases_project').on(t.project_id, t.updated_at),
  ],
)

/** Yjs 增量更新，按 id 顺序重放；定期合并成一条 */
export const docUpdates = sqliteTable(
  'doc_updates',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    canvas_id: text()
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    data: blob({ mode: 'buffer' }).notNull(),
    created_at: integer().notNull(),
  },
  (t) => [index('doc_updates_canvas').on(t.canvas_id, t.id)],
)

/** 资产内容按哈希共享存储，元数据按所有者各一行 */
export const assets = sqliteTable(
  'assets',
  {
    id: text().notNull(),
    owner_id: text().notNull(),
    kind: text().$type<AssetKind>().notNull(),
    mime: text().notNull(),
    name: text().notNull(),
    size: integer().notNull(),
    width: integer(),
    height: integer(),
    duration: real(),
    variants: text().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner_id, t.id] })],
)

/** 用户存的模板（Frame 及其内容，JSON 同复制粘贴格式） */
export const templates = sqliteTable(
  'templates',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    title: text().notNull(),
    data: text().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [index('templates_owner').on(t.owner_id, t.created_at)],
)

/** 节点运行任务：id 即画布上节点的 run.id 和结果的 runId */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    canvas_id: text()
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    node_id: text().notNull(),
    group_id: text(),
    node_type: text().notNull(),
    /** queued | running | succeeded | failed | canceled */
    status: text().$type<JobStatus>().notNull(),
    attempts: integer().notNull().default(0),
    /** 节点类型、参数、输入的哈希；与当前算出的一致说明结果仍然有效 */
    cache_key: text(),
    /** 由运行结果写回的参数（如分镜），算缓存键时不计入，JSON 数组 */
    cache_omit: text(),
    /** 模型调用记录（见 CallJournal），重启后据此续跑 */
    calls: text().notNull().default('{}'),
    /** 提交时的实际输入（PreparedInput JSON）：引用、降级、模型与有效参数 */
    input: text(),
    error: text(),
    created_at: integer().notNull(),
    started_at: integer(),
    finished_at: integer(),
  },
  (t) => [
    index('jobs_active')
      .on(t.status)
      .where(sql`status IN ('queued', 'running')`),
    index('jobs_node').on(t.canvas_id, t.node_id, t.created_at),
  ],
)

/** 整组运行（Frame）：服务端按依赖调度，重启后继续 */
export const jobGroups = sqliteTable(
  'job_groups',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    canvas_id: text()
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    frame_id: text().notNull(),
    options: text().notNull(),
    targets: text().notNull(),
    /** running | done | canceled */
    status: text().$type<'running' | 'done' | 'canceled'>().notNull(),
    summary: text(),
    created_at: integer().notNull(),
    finished_at: integer(),
  },
  (t) => [
    index('job_groups_active')
      .on(t.status)
      .where(sql`status = 'running'`),
  ],
)

/**
 * 影响分析里的保留决定：用户确认过期结果先留着。只追加，撤销时记 revoked_at，事后可查；
 * 不改任务的缓存键，input_hash 或采用的结果变了决定就不再适用
 */
export const impactDecisions = sqliteTable(
  'impact_decisions',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    canvas_id: text()
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    node_id: text().notNull(),
    /** 保留的那个结果 */
    result_id: text().notNull(),
    /** 决定时的实际输入哈希（PreparedInput.inputHash） */
    input_hash: text().notNull(),
    /** 决定时的过期原因（ImpactCause[] JSON） */
    causes: text().notNull().default('[]'),
    note: text(),
    created_at: integer().notNull(),
    revoked_at: integer(),
  },
  (t) => [index('impact_decisions_canvas').on(t.canvas_id, t.created_at)],
)

/** 本机智能体会话：对话记录存 JSON，cli_session 是 Claude Code / Codex 自己的会话 id，用于续聊 */
export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    canvas_id: text()
      .notNull()
      .references(() => canvases.id, { onDelete: 'cascade' }),
    agent: text().$type<AgentKind>().notNull(),
    cli_session: text(),
    title: text().notNull(),
    items: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index('agent_sessions_canvas').on(t.canvas_id, t.updated_at)],
)

/** 资产库：角色 / 场景 / 道具 / 风格 / 特效。图片等二进制在 assets，这里只存设定与资产 id */
export const libraryItems = sqliteTable(
  'library_items',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    /** 归属项目；删项目时条目保留、变成不归属任何项目 */
    project_id: text().references(() => projects.id, { onDelete: 'set null' }),
    kind: text().notNull(),
    name: text().notNull(),
    /** description / tags / voice / images / video / models，JSON */
    data: text().notNull(),
    favorite: integer().notNull().default(0),
    used_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index('library_owner').on(t.owner_id, t.kind, t.updated_at)],
)

// ---- Better Auth（drizzle 适配器）----
// 列名和存储格式沿用 Better Auth 自带迁移建的表：时间存 ISO 字符串，布尔存 0 / 1

/** ISO 8601 字符串存储的时间，读出来是 Date */
const isoDate = customType<{ data: Date; driverData: string }>({
  dataType: () => 'date',
  toDriver: (value) => value.toISOString(),
  fromDriver: (value) => new Date(value),
})

export const user = sqliteTable('user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: 'boolean' }).notNull(),
  image: text(),
  createdAt: isoDate().notNull(),
  updatedAt: isoDate().notNull(),
})

export const session = sqliteTable(
  'session',
  {
    id: text().primaryKey(),
    expiresAt: isoDate().notNull(),
    token: text().notNull().unique(),
    createdAt: isoDate().notNull(),
    updatedAt: isoDate().notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: isoDate(),
    refreshTokenExpiresAt: isoDate(),
    scope: text(),
    password: text(),
    createdAt: isoDate().notNull(),
    updatedAt: isoDate().notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
)

export const verification = sqliteTable(
  'verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: isoDate().notNull(),
    createdAt: isoDate().notNull(),
    updatedAt: isoDate().notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)
