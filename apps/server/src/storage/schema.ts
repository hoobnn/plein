import type { AgentKind, AssetKind, JobStatus } from '@plein/protocol'
import { sql } from 'drizzle-orm'
import {
  blob,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
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
    /** 只追加的提交及人工恢复事件；不参与活动调用恢复、不进入共享项目包。 */
    call_history: text().notNull().default('[]'),
    /** 提交时的实际输入（PreparedInput JSON）：引用、降级、模型与有效参数 */
    input: text(),
    /**
     * 用户或批次批准的计划（JobExpect JSON）：执行前重新准备，与它不一致就不提交，
     * 记为需要重新审查
     */
    expect: text(),
    /** 提交时冻结的参数与输入值（JSON）；续查、重启、重新获取都按它执行，不再读画布 */
    frozen: text(),
    /** 恢复状态（JobRecovery JSON）：失败在哪一步、谁取消的、产物是否待采用 */
    recovery: text(),
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
 * 批次快照：整组运行启动时每个目标的执行阶段、批准的实际输入与待解析依赖。
 * 只存在服务端任务层，进度留在运行时，不写进画布文档
 */
export const batchItems = sqliteTable(
  'batch_items',
  {
    group_id: text()
      .notNull()
      .references(() => jobGroups.id, { onDelete: 'cascade' }),
    node_id: text().notNull(),
    seq: integer().notNull(),
    /** run | reuse | blocked */
    stage: text().notNull(),
    reason: text(),
    /** 启动时批准的 inputHash；有待解析依赖时为空 */
    input_hash: text(),
    /** 节点自身参数与模型的哈希：有待解析依赖时据此判断计划有没有变 */
    plan_hash: text(),
    /** 待解析的依赖（BatchDependency[] JSON） */
    deps: text().notNull().default('[]'),
    /** 启动时的实际输入（PreparedInput JSON） */
    input: text(),
    /** 实际提交时冻结的 inputHash */
    frozen_hash: text(),
    job_id: text(),
    /** BatchOutcome */
    outcome: text().notNull().default('pending'),
    /** 本批次落定的结果 */
    result_id: text(),
    updated_at: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.group_id, t.node_id] })],
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
    /** 会话覆盖配置与最近一次可信的上下文状态，JSON。 */
    settings: text().notNull().default('{}'),
    context: text().notNull().default('{"source":"unavailable","messages":0}'),
    /** 重置只改变后续模型历史，展示记录与执行事实保留。 */
    context_cutoff: integer(),
    context_reset_at: integer(),
    title: text().notNull(),
    items: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [index('agent_sessions_canvas').on(t.canvas_id, t.updated_at)],
)

/** 资产库：角色 / 场景 / 道具 / 风格 / 特效。图片等二进制在 assets，这里只存设定与资产 id */
/** 我的音色：复刻或登记的平台音色，见 @plein/protocol 的 Voice */
export const voices = sqliteTable(
  'voices',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    provider: text().notNull(),
    voice_id: text().notNull(),
    name: text().notNull(),
    status: text().notNull(),
    /** message / sampleAssetId / gender / age / credentialId / credentialFingerprint 等，JSON */
    data: text().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (t) => [uniqueIndex('voices_owner_voice').on(t.owner_id, t.provider, t.voice_id)],
)

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

/** 一轮智能体执行的原始交换与业务回执；展示摘要仍在 agent_sessions.items。 */
export const agentTurns = sqliteTable(
  'agent_turns',
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    state: text()
      .$type<'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted'>()
      .notNull(),
    model_ref: text(),
    transcript: text().notNull().default('[]'),
    execution: text().notNull().default('{}'),
    reason: text(),
    created_at: integer().notNull(),
    closed_at: integer(),
  },
  (t) => [index('agent_turns_session').on(t.session_id, t.created_at)],
)

/** 可重建的媒体来源投影，资产拥有权仍由 assets 决定。 */
export const mediaSources = sqliteTable(
  'media_sources',
  {
    owner_id: text().notNull(),
    asset_id: text().notNull(),
    source_type: text().notNull(),
    source_id: text().notNull(),
    locator: text().notNull(),
    project_id: text(),
    canvas_id: text(),
    node_id: text(),
    result_id: text(),
    label: text().notNull(),
    created_at: integer().notNull(),
    adopted: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.owner_id, t.asset_id, t.source_type, t.source_id, t.locator] }),
    index('media_sources_project').on(t.owner_id, t.project_id, t.asset_id),
    index('media_sources_source').on(t.owner_id, t.source_type, t.source_id),
  ],
)

export const mediaIndexMeta = sqliteTable('media_index_meta', {
  id: integer().primaryKey(),
  version: integer().notNull(),
  completed_at: integer(),
})

/** 命名创作检查点随项目保留，删除原画布不删除检查点。 */
export const canvasCheckpoints = sqliteTable(
  'canvas_checkpoints',
  {
    id: text().primaryKey(),
    owner_id: text().notNull(),
    project_id: text()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source_canvas_id: text().references(() => canvases.id, { onDelete: 'set null' }),
    source_canvas_title: text().notNull(),
    name: text().notNull(),
    state: blob({ mode: 'buffer' }).notNull(),
    history: text().notNull().default('[]'),
    created_at: integer().notNull(),
    content_hash: text().notNull(),
  },
  (t) => [index('canvas_checkpoints_project').on(t.owner_id, t.project_id, t.created_at)],
)

export const checkpointAssets = sqliteTable(
  'checkpoint_assets',
  {
    checkpoint_id: text()
      .notNull()
      .references(() => canvasCheckpoints.id, { onDelete: 'cascade' }),
    owner_id: text().notNull(),
    asset_id: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.checkpoint_id, t.owner_id, t.asset_id] }),
    foreignKey({
      columns: [t.owner_id, t.asset_id],
      foreignColumns: [assets.owner_id, assets.id],
    }).onDelete('restrict'),
  ],
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
