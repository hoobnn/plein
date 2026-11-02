import type { MediaSource } from '@plein/protocol'
import type { DB } from '../storage/db'

/**
 * 素材索引的存储模块：索引表（media_sources / media_index_meta）的读写，
 * 以及重建投影时读源表的查询，都收在这里。
 * 见 CONTRIBUTING.md「结构调整约定 › 数据访问」。
 *
 * 索引是派生数据：资产清单是事实来源，本表可从文档、任务、资产库和检查点完整重建。
 */

/** 索引表的一行来源 */
export interface SourceRow {
  owner_id: string
  asset_id: string
  source_type: MediaSource['type']
  source_id: string
  locator: string
  project_id: string | null
  canvas_id: string | null
  node_id: string | null
  result_id: string | null
  label: string
  created_at: number
  adopted: number
}

/** 索引的构建状态 */
export interface IndexMetaRow {
  version: number
  completed_at: number | null
}

/** 把用户输入里的 LIKE 通配符转义掉 */
const literalLike = (text: string) =>
  `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

export class MediaIndexStore {
  constructor(private db: DB) {}
  rows<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.$client.prepare(sql).all(...args) as T[]
  }

  one<T>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.$client.prepare(sql).get(...args) as T | undefined
  }

  run(sql: string, ...args: unknown[]) {
    return this.db.$client.prepare(sql).run(...args)
  }

  // ── 索引表 ────────────────────────────────────────

  /** 索引是否建完 */
  meta(): IndexMetaRow | undefined {
    return this.one<IndexMetaRow>('SELECT version, completed_at FROM media_index_meta WHERE id = 1')
  }

  /** 标记索引未完成 */
  markIncomplete(version: number): void {
    this.run(
      'INSERT INTO media_index_meta(id,version,completed_at) VALUES(1,?,NULL) ON CONFLICT(id) DO UPDATE SET version=excluded.version,completed_at=NULL',
      version,
    )
  }

  /** 标记索引建完 */
  markComplete(version: number): void {
    this.run('UPDATE media_index_meta SET version=?,completed_at=? WHERE id=1', version, Date.now())
  }

  /** 清空索引，准备整表重建 */
  clearSources(): void {
    this.run('DELETE FROM media_sources')
  }

  /** 替换某个来源的全部来源行；素材已不在清单里的不写入 */
  replaceSources(type: MediaSource['type'], id: string, rows: SourceRow[]): void {
    this.db.$client.transaction(() => {
      this.run('DELETE FROM media_sources WHERE source_type=? AND source_id=?', type, id)
      const put = this.db.$client.prepare(
        'INSERT OR IGNORE INTO media_sources(owner_id,asset_id,source_type,source_id,locator,project_id,canvas_id,node_id,result_id,label,created_at,adopted) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assets WHERE owner_id=? AND id=?)',
      )
      for (const r of rows)
        put.run(
          r.owner_id,
          r.asset_id,
          r.source_type,
          r.source_id,
          r.locator,
          r.project_id,
          r.canvas_id,
          r.node_id,
          r.result_id,
          r.label,
          r.created_at,
          r.adopted,
          r.owner_id,
          r.asset_id,
        )
    })()
  }

  /** 清掉源表里已删除的来源，并把资产库条目的项目补回索引 */
  purgeDeletedSources(): void {
    for (const [kind, table] of [
      ['canvas', 'canvases'],
      ['job', 'jobs'],
      ['library', 'library_items'],
      ['checkpoint', 'canvas_checkpoints'],
    ] as const)
      this.run(
        `DELETE FROM media_sources WHERE source_type=? AND NOT EXISTS(SELECT 1 FROM ${table} t WHERE t.id=media_sources.source_id AND t.owner_id=media_sources.owner_id)`,
        kind,
      )
    this.run(
      "UPDATE media_sources SET project_id=(SELECT project_id FROM library_items WHERE id=media_sources.source_id) WHERE source_type='library'",
    )
  }

  // ── 重建时的源表读取 ──────────────────────────────

  /** 源表里所有可投影记录的 id */
  sourceIds(table: 'canvases' | 'jobs' | 'library_items' | 'canvas_checkpoints'): string[] {
    return this.rows<{ id: string }>(`SELECT id FROM ${table}`).map((r) => r.id)
  }

  /** 画布 */
  canvas(id: string) {
    return this.one<{
      owner_id: string
      project_id: string | null
      title: string
      created_at: number
    }>('SELECT owner_id,project_id,title,created_at FROM canvases WHERE id=?', id)
  }

  /** 任务 */
  job(id: string) {
    return this.one<{
      owner_id: string
      canvas_id: string
      project_id: string | null
      node_id: string
      node_type: string
      title: string
      calls: string
      recovery: string | null
      created_at: number
    }>(
      'SELECT j.*,c.project_id,c.title FROM jobs j JOIN canvases c ON c.id=j.canvas_id AND c.owner_id=j.owner_id WHERE j.id=?',
      id,
    )
  }

  /** 资产库条目 */
  library(id: string) {
    return this.one<{
      owner_id: string
      project_id: string | null
      name: string
      data: string
      created_at: number
    }>('SELECT * FROM library_items WHERE id=?', id)
  }

  /** 检查点 */
  checkpoint(id: string) {
    return this.one<{ owner_id: string; project_id: string; name: string; created_at: number }>(
      'SELECT * FROM canvas_checkpoints WHERE id=?',
      id,
    )
  }

  /** 检查点引用的素材 */
  checkpointAssets(id: string) {
    return this.rows<{ asset_id: string }>(
      'SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=?',
      id,
    )
  }

  // ── 素材库查询 ────────────────────────────────────

  /** 项目是否存在 */
  projectExists(owner: string, id: string): boolean {
    return !!this.one('SELECT id FROM projects WHERE id=? AND owner_id=?', id, owner)
  }

  /** 画布是否存在 */
  canvasExists(id: string, owner: string): boolean {
    return !!this.one('SELECT id FROM canvases WHERE id=? AND owner_id=?', id, owner)
  }

  /** 素材是否存在 */
  assetExists(owner: string, id: string): boolean {
    return !!this.one('SELECT id FROM assets WHERE owner_id=? AND id=?', owner, id)
  }

  /** 按条件分页列出素材 */
  listAssets(
    query: {
      owner: string
      asOf: number
      kind?: string
      projectId?: string
      q?: string
      cursor?: Record<string, unknown> | null
    },
    limit: number,
  ) {
    const conditions = ['a.owner_id=?', "a.kind IN ('image','video','audio')", 'a.created_at<=?']
    const args: unknown[] = [query.owner, query.asOf]
    if (query.kind) {
      conditions.push('a.kind=?')
      args.push(query.kind)
    }
    if (query.projectId) {
      conditions.push(
        'EXISTS(SELECT 1 FROM media_sources s WHERE s.owner_id=a.owner_id AND s.asset_id=a.id AND s.project_id=?)',
      )
      args.push(query.projectId)
    }
    if (query.q) {
      conditions.push(
        "(a.name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM media_sources s WHERE s.owner_id=a.owner_id AND s.asset_id=a.id AND s.label LIKE ? ESCAPE '\\'))",
      )
      args.push(literalLike(query.q), literalLike(query.q))
    }
    if (query.cursor) {
      conditions.push('(a.created_at<? OR (a.created_at=? AND a.id<?))')
      args.push(query.cursor.at, query.cursor.at, query.cursor.id)
    }
    return this.rows<Record<string, unknown>>(
      `SELECT a.* FROM assets a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      ...args,
      limit,
    )
  }

  /** 一批素材各自的来源数 */
  sourceCounts(owner: string, assetIds: string[]) {
    const placeholders = assetIds.map(() => '?').join(',')
    return this.rows<{ asset_id: string; n: number }>(
      `SELECT asset_id, count(*) n FROM media_sources WHERE owner_id=? AND asset_id IN (${placeholders}) GROUP BY asset_id`,
      owner,
      ...assetIds,
    )
  }

  /** 一批素材的来源行：每个素材在 SQL 层只取前三条 */
  assetSources(owner: string, assetIds: string[]) {
    const placeholders = assetIds.map(() => '?').join(',')
    return this.rows<SourceRow>(
      // 每个素材只在 SQL 层取前三条来源：来源多的素材不会把整页的行都拉进内存。
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY asset_id ORDER BY source_type,source_id,locator
         ) AS rn
         FROM media_sources
         WHERE owner_id=? AND asset_id IN (${placeholders})
       ) WHERE rn<=3 ORDER BY asset_id,source_type,source_id,locator`,
      owner,
      ...assetIds,
    )
  }

  /** 一个素材的来源行，分页 */
  assetSourcePage(after: string, args: unknown[], limit: number) {
    return this.rows<SourceRow>(
      `SELECT * FROM media_sources WHERE owner_id=? AND asset_id=?${after} ORDER BY source_type,source_id,locator LIMIT ?`,
      ...args,
      limit,
    )
  }
}
