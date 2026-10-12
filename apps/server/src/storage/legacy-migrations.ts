/**
 * 改用 Drizzle 之前手写的 schema 迁移，版本号记在 PRAGMA user_version。已冻结，不再追加：
 * 只用来把旧数据库补到最后一版，再交给 Drizzle 迁移（见 migrate.ts 的 upgradeLegacy）。
 */
export const LEGACY_MIGRATIONS: string[] = [
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
  `
  -- 本机智能体会话：对话记录存 JSON，cli_session 是 Claude Code / Codex 自己的会话 id，用于续聊
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    cli_session TEXT,
    title TEXT NOT NULL,
    items TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX agent_sessions_canvas ON agent_sessions(canvas_id, updated_at);
  `,
  `
  -- 项目：一个项目下挂多张画布
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX projects_owner ON projects(owner_id, updated_at);

  ALTER TABLE canvases ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
  -- 已有画布各自成为一个同名项目，链接和内容都不变
  INSERT INTO projects (id, owner_id, title, created_at, updated_at)
    SELECT 'pj_' || id, owner_id, title, created_at, updated_at FROM canvases;
  UPDATE canvases SET project_id = 'pj_' || id;
  CREATE INDEX canvases_project ON canvases(project_id, updated_at);

  -- 资产库：角色 / 场景 / 道具 / 风格 / 特效。图片等二进制在 assets，这里只存设定与资产 id
  CREATE TABLE library_items (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    -- 归属项目；删项目时条目保留、变成不归属任何项目
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    -- description / tags / voice / images / video / models，JSON
    data TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX library_owner ON library_items(owner_id, kind, updated_at);
  `,
]
