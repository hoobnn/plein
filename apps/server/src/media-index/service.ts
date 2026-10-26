import { createHash } from 'node:crypto'
import type {
  Asset,
  MediaLibraryPage,
  MediaLibraryQuery,
  MediaSource,
  MediaSourcesPage,
} from '@plein/protocol'
import type * as Y from 'yjs'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { canvasState, documentReferences, readDocument, stringReferences } from './references'

const INDEX_VERSION = 2
type SqlRow = Record<string, unknown>
type SourceKind = MediaSource['type']
type SourceRow = {
  owner_id: string
  asset_id: string
  source_type: SourceKind
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

export class MediaIndexError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'media_index_building',
    message: string,
  ) {
    super(message)
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const json = (value: string | null | undefined): unknown => {
  try {
    return JSON.parse(value ?? 'null')
  } catch {
    return null
  }
}
const literalLike = (text: string) =>
  `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

export function createMediaIndex(deps: { db: DB; rooms: Rooms }) {
  return new MediaIndex(deps.db, deps.rooms)
}

/** 资产清单是事实来源；来源投影可从文档、任务、资产库和检查点完整重建。 */
export class MediaIndex {
  private dirty = new Set<string>()
  private detach = new Map<string, () => void>()
  private disposers: Array<() => void> = []
  private rebuilding: Promise<void> | null = null
  private repairTimer: NodeJS.Timeout | null = null
  private repairDelay = 1000
  private repairRevision = 0
  private incomplete = false
  private installed = false
  private closed = false
  constructor(
    readonly db: DB,
    readonly rooms: Rooms,
  ) {}

  private rows<T>(sql: string, ...args: unknown[]) {
    return this.db.$client.prepare(sql).all(...args) as T[]
  }
  private one<T>(sql: string, ...args: unknown[]) {
    return this.db.$client.prepare(sql).get(...args) as T | undefined
  }
  private run(sql: string, ...args: unknown[]) {
    return this.db.$client.prepare(sql).run(...args)
  }

  install() {
    if (this.installed || this.closed) return
    this.installed = true
    const watch = (id: string) => {
      if (this.detach.has(id)) return
      const room = this.rooms.get(id)
      const changed = (transaction: Y.Transaction) => {
        const elements = room.doc.getMap('elements')
        for (const [type, keys] of transaction.changed) {
          if (
            (type as unknown) === elements ||
            [...keys].some(
              (key) =>
                key === 'assetId' || key === 'results' || key === 'adopted' || key === 'name',
            ) ||
            type._item?.parentSub === 'params'
          ) {
            this.dirty.add(id)
            return
          }
        }
      }
      room.doc.on('afterTransaction', changed)
      const destroyed = () => {
        this.detach.delete(id)
        if (!this.closed && this.dirty.delete(id)) this.refreshCanvas(id)
      }
      const remove = () => {
        room.doc.off('afterTransaction', changed)
        room.doc.off('destroy', destroyed)
      }
      this.detach.set(id, remove)
      room.doc.on('destroy', destroyed)
      this.dirty.add(id)
    }
    this.disposers.push(
      this.rooms.onLoad(watch),
      this.rooms.onDrop((id) => {
        this.detach.get(id)?.()
        this.detach.delete(id)
        this.dirty.delete(id)
        this.projectSafely(() => this.purgeDeletedSources())
      }),
    )
    for (const id of this.rooms.loaded()) watch(id)
  }

  close() {
    this.closed = true
    if (this.repairTimer) clearTimeout(this.repairTimer)
    this.repairTimer = null
    for (const fn of this.disposers) fn()
    for (const fn of this.detach.values()) fn()
    this.detach.clear()
    this.dirty.clear()
    this.installed = false
  }
  flush() {
    for (const id of [...this.dirty]) {
      this.refreshCanvas(id)
      this.dirty.delete(id)
    }
  }
  /** 放在 doc_updates 持久化事务内；纯布局更新不重建媒体投影。 */
  refreshPersistedCanvas(id: string) {
    if (this.closed) return
    if (!this.rooms.has(id) || this.dirty.has(id)) {
      this.refreshCanvas(id)
      this.dirty.delete(id)
    }
  }
  get ready() {
    if (this.closed || this.incomplete) return false
    const meta = this.one<{ version: number; completed_at: number | null }>(
      'SELECT version, completed_at FROM media_index_meta WHERE id = 1',
    )
    return !this.rebuilding && meta?.version === INDEX_VERSION && meta.completed_at != null
  }

  rebuild(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.rebuilding) return this.rebuilding
    this.incomplete = true
    const revision = this.repairRevision
    const build = async () => {
      if (this.closed) return
      this.markIncomplete()
      this.run('DELETE FROM media_sources')
      const groups = [
        ['SELECT id FROM canvases', (id: string) => this.refreshCanvas(id)],
        ['SELECT id FROM jobs', (id: string) => this.refreshJob(id)],
        ['SELECT id FROM library_items', (id: string) => this.refreshLibrary(id)],
        ['SELECT id FROM canvas_checkpoints', (id: string) => this.refreshCheckpoint(id)],
      ] as const
      for (const [query, refresh] of groups) {
        if (this.closed) return
        for (const { id } of this.rows<{ id: string }>(query)) {
          if (this.closed) return
          refresh(id)
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
      if (this.closed) return
      this.flush()
      this.purgeDeletedSources()
      // 补建让出事件循环时，非文档投影可能失败；那次来源必须经下一次完整补建确认。
      if (revision !== this.repairRevision) {
        this.scheduleRepair()
        return
      }
      this.run(
        'UPDATE media_index_meta SET version=?,completed_at=? WHERE id=1',
        INDEX_VERSION,
        Date.now(),
      )
      this.incomplete = false
      this.repairDelay = 1000
      if (this.repairTimer) clearTimeout(this.repairTimer)
      this.repairTimer = null
    }
    this.rebuilding = build()
      .catch((error) => {
        this.scheduleRepair()
        throw error
      })
      .finally(() => {
        this.rebuilding = null
      })
    return this.rebuilding
  }

  private markIncomplete() {
    this.run(
      'INSERT INTO media_index_meta(id,version,completed_at) VALUES(1,?,NULL) ON CONFLICT(id) DO UPDATE SET version=excluded.version,completed_at=NULL',
      INDEX_VERSION,
    )
  }

  private scheduleRepair() {
    if (this.closed || this.repairTimer) return
    const delay = this.repairDelay
    this.repairDelay = Math.min(delay * 2, 30_000)
    this.repairTimer = setTimeout(() => {
      this.repairTimer = null
      if (this.closed) return
      if (this.rebuilding) {
        this.scheduleRepair()
        return
      }
      void this.rebuild().catch((error) => console.error('[media-index] repair failed', error))
    }, delay)
    this.repairTimer.unref?.()
  }

  private projectSafely(project: () => void) {
    if (this.closed) return
    try {
      project()
    } catch (error) {
      this.incomplete = true
      this.repairRevision++
      console.error('[media-index] projection failed; rebuilding', error)
      try {
        this.markIncomplete()
      } catch (markError) {
        // 即使 SQLite 此刻不可写，内存状态仍会拒绝读取一份被误认为完整的索引。
        console.error('[media-index] incomplete marker failed', markError)
      }
      this.scheduleRepair()
    }
  }

  /** canonical 写入已经成功；派生索引故障不能把它变成不确定的失败结果。 */
  refreshJobSafely(id: string) {
    this.projectSafely(() => this.refreshJob(id))
  }
  refreshLibrarySafely(id: string) {
    this.projectSafely(() => this.refreshLibrary(id))
  }

  private replace(type: SourceKind, id: string, rows: SourceRow[]) {
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

  refreshCanvas(id: string) {
    const row = this.one<{
      owner_id: string
      project_id: string | null
      title: string
      created_at: number
    }>('SELECT owner_id,project_id,title,created_at FROM canvases WHERE id=?', id)
    if (!row) {
      this.replace('canvas', id, [])
      return
    }
    const refs = readDocument(canvasState(this.db, this.rooms, id), documentReferences)
    this.replace(
      'canvas',
      id,
      refs.map((ref) => ({
        owner_id: row.owner_id,
        asset_id: ref.assetId,
        source_type: 'canvas',
        source_id: id,
        locator: ref.locator,
        project_id: row.project_id,
        canvas_id: id,
        node_id: ref.nodeId,
        result_id: ref.resultId,
        label: `${row.title} / ${ref.label}`,
        created_at: row.created_at,
        adopted: +ref.adopted,
      })),
    )
  }

  refreshJob(id: string) {
    const row = this.one<{
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
    if (!row) {
      this.replace('job', id, [])
      return
    }
    const rows: SourceRow[] = []
    const add = (assetId: string, locator: string) =>
      rows.push({
        owner_id: row.owner_id,
        asset_id: assetId,
        source_type: 'job',
        source_id: id,
        locator,
        project_id: row.project_id,
        canvas_id: row.canvas_id,
        node_id: row.node_id,
        result_id: null,
        label: `${row.title} / ${row.node_type}`,
        created_at: row.created_at,
        adopted: 0,
      })
    const calls = json(row.calls)
    if (calls && typeof calls === 'object')
      for (const [key, call] of Object.entries(calls)) {
        if (call?.state === 'done')
          stringReferences(call.result?.assets, (asset, path) => add(asset, `calls/${key}${path}`))
      }
    const recovery = json(row.recovery) as { assets?: unknown } | null
    stringReferences(recovery?.assets, (asset, path) => add(asset, `recovery${path}`))
    this.replace('job', id, rows)
  }

  refreshLibrary(id: string) {
    const row = this.one<{
      owner_id: string
      project_id: string | null
      name: string
      data: string
      created_at: number
    }>('SELECT * FROM library_items WHERE id=?', id)
    const rows: SourceRow[] = []
    if (row) {
      const data = json(row.data) as {
        images?: unknown
        video?: unknown
        profile?: unknown
        sceneViews?: unknown
      } | null
      stringReferences(
        {
          images: data?.images,
          video: data?.video,
          profile: data?.profile,
          sceneViews: data?.sceneViews,
        },
        (asset, path) =>
          rows.push({
            owner_id: row.owner_id,
            asset_id: asset,
            source_type: 'library',
            source_id: id,
            locator: path,
            project_id: row.project_id,
            canvas_id: null,
            node_id: null,
            result_id: null,
            label: row.name,
            created_at: row.created_at,
            adopted: 0,
          }),
      )
    }
    this.replace('library', id, rows)
  }

  refreshCheckpoint(id: string) {
    const cp = this.one<{ owner_id: string; project_id: string; name: string; created_at: number }>(
      'SELECT * FROM canvas_checkpoints WHERE id=?',
      id,
    )
    const refs = this.rows<{ asset_id: string }>(
      'SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=?',
      id,
    )
    this.replace(
      'checkpoint',
      id,
      cp
        ? refs.map((r) => ({
            owner_id: cp.owner_id,
            asset_id: r.asset_id,
            source_type: 'checkpoint',
            source_id: id,
            locator: r.asset_id,
            project_id: cp.project_id,
            canvas_id: null,
            node_id: null,
            result_id: null,
            label: cp.name,
            created_at: cp.created_at,
            adopted: 0,
          }))
        : [],
    )
  }

  purgeDeletedSources() {
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

  private requireReady() {
    if (!this.ready)
      throw new MediaIndexError('media_index_building', '正在建立素材索引，请稍后重试')
    this.flush()
    this.purgeDeletedSources()
  }
  private requireProject(owner: string, id?: string) {
    if (id && !this.one('SELECT id FROM projects WHERE id=? AND owner_id=?', id, owner))
      throw new MediaIndexError('not_found', '项目不存在')
  }
  private cursor(value: string | undefined, filter: string): SqlRow | null {
    if (!value) return null
    try {
      const c = JSON.parse(Buffer.from(value, 'base64url').toString())
      if (
        c.filter !== filter ||
        !Number.isSafeInteger(c.asOf) ||
        typeof c.id !== 'string' ||
        !Number.isSafeInteger(c.at)
      )
        throw new Error()
      return c
    } catch {
      throw new MediaIndexError('invalid', '分页游标无效，请重新读取素材')
    }
  }

  list(owner: string, query: MediaLibraryQuery): MediaLibraryPage {
    this.requireReady()
    this.requireProject(owner, query.projectId)
    const filter = digest([owner, query.projectId ?? '', query.kind ?? '', query.q])
    const cursor = this.cursor(query.cursor, filter)
    const asOf = (cursor?.asOf as number | undefined) ?? Date.now()
    const conditions = ['a.owner_id=?', "a.kind IN ('image','video','audio')", 'a.created_at<=?']
    const args: unknown[] = [owner, asOf]
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
    if (cursor) {
      conditions.push('(a.created_at<? OR (a.created_at=? AND a.id<?))')
      args.push(cursor.at, cursor.at, cursor.id)
    }
    const rows = this.rows<SqlRow>(
      `SELECT a.* FROM assets a WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
      ...args,
      query.limit + 1,
    )
    const more = rows.length > query.limit
    const shown = rows.slice(0, query.limit)
    const canvasNodes = new Map<string, Set<string>>()
    const items = shown.map((r) => {
      const sourceCount = this.one<{ n: number }>(
        'SELECT count(*) n FROM media_sources WHERE owner_id=? AND asset_id=?',
        owner,
        r.id,
      )!.n
      const sources = this.sourceRows(owner, r.id as string, 3).map((s) =>
        this.source(s, canvasNodes),
      )
      return {
        id: r.id,
        kind: r.kind,
        mime: r.mime,
        name: r.name,
        size: r.size,
        width: r.width ?? undefined,
        height: r.height ?? undefined,
        duration: r.duration ?? undefined,
        variants: json(r.variants as string) ?? [],
        createdAt: r.created_at,
        sourceCount,
        sources,
      } as Asset & { sourceCount: number; sources: MediaSource[] }
    })
    const last = shown.at(-1)
    return {
      items,
      nextCursor: more && last ? encode({ filter, asOf, at: last.created_at, id: last.id }) : null,
    }
  }

  private sourceRows(owner: string, asset: string, limit: number) {
    return this.rows<SourceRow>(
      'SELECT * FROM media_sources WHERE owner_id=? AND asset_id=? ORDER BY source_type,source_id,locator LIMIT ?',
      owner,
      asset,
      limit,
    )
  }
  private source(r: SourceRow, canvasNodes: Map<string, Set<string>>): MediaSource {
    if (
      r.canvas_id &&
      r.node_id &&
      !canvasNodes.has(r.canvas_id) &&
      this.one('SELECT id FROM canvases WHERE id=? AND owner_id=?', r.canvas_id, r.owner_id)
    )
      canvasNodes.set(
        r.canvas_id,
        readDocument(
          canvasState(this.db, this.rooms, r.canvas_id),
          (doc) => new Set([...doc.elements()].map((el) => el.id)),
        ),
      )
    const locatable = !!r.canvas_id && !!r.node_id && !!canvasNodes.get(r.canvas_id)?.has(r.node_id)
    return {
      type: r.source_type,
      id: r.source_id,
      locator: r.locator,
      projectId: r.project_id,
      canvasId: r.canvas_id,
      nodeId: r.node_id,
      resultId: r.result_id,
      label: r.label,
      createdAt: r.created_at,
      adopted: !!r.adopted,
      locatable,
    }
  }

  sources(
    owner: string,
    asset: string,
    query: { cursor?: string; limit: number },
  ): MediaSourcesPage {
    this.requireReady()
    if (!this.one('SELECT id FROM assets WHERE owner_id=? AND id=?', owner, asset))
      throw new MediaIndexError('not_found', '素材不存在')
    const filter = digest([owner, asset])
    const cursor = this.cursor(query.cursor, filter)
    const args: unknown[] = [owner, asset]
    let after = ''
    if (cursor) {
      if (
        !Array.isArray(cursor.keys) ||
        cursor.keys.length !== 3 ||
        !cursor.keys.every((k) => typeof k === 'string')
      )
        throw new MediaIndexError('invalid', '来源游标无效')
      after = ' AND (source_type,source_id,locator)>(?,?,?)'
      args.push(...cursor.keys)
    }
    const rows = this.rows<SourceRow>(
      `SELECT * FROM media_sources WHERE owner_id=? AND asset_id=?${after} ORDER BY source_type,source_id,locator LIMIT ?`,
      ...args,
      query.limit + 1,
    )
    const shown = rows.slice(0, query.limit),
      last = shown.at(-1)
    const canvasNodes = new Map<string, Set<string>>()
    return {
      items: shown.map((r) => this.source(r, canvasNodes)),
      nextCursor:
        rows.length > query.limit && last
          ? encode({
              filter,
              asOf: Date.now(),
              at: 0,
              id: asset,
              keys: [last.source_type, last.source_id, last.locator],
            })
          : null,
    }
  }
}
