import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createDoc, type NodeResult } from '@plein/doc'
import type {
  CanvasCheckpoint,
  CheckpointDetail,
  CheckpointPage,
  CheckpointQuery,
  CheckpointRestored,
  CreateCheckpoint,
  PackageJob,
} from '@plein/protocol'
import * as Y from 'yjs'
import type { AssetStore } from '../assets/store'
import type { MediaIndex } from '../media-index/service'
import { newCanvasId } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { checkpointAssetIds, type CheckpointRow } from './archive'

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`
const sha = (state: Uint8Array) => createHash('sha256').update(state).digest('hex')

export class CheckpointError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'sync_pending' | 'unsupported_version',
    message: string,
  ) {
    super(message)
  }
}

/** 增量时钟和全部删除区间都已收到才可抓取；单独 state vector 会漏掉纯删除。 */
export function includesSnapshot(actual: Y.Snapshot, expected: Y.Snapshot) {
  return (
    [...expected.sv].every(([client, clock]) => (actual.sv.get(client) ?? 0) >= clock) &&
    Y.equalDeleteSets(actual.ds, Y.mergeDeleteSets([actual.ds, expected.ds]))
  )
}

export function createCheckpointService(deps: {
  db: DB
  rooms: Rooms
  assets: AssetStore
  index: MediaIndex
}) {
  return new CheckpointService(deps)
}

export class CheckpointService {
  constructor(readonly deps: { db: DB; rooms: Rooms; assets: AssetStore; index: MediaIndex }) {}
  private get db() {
    return this.deps.db.$client
  }
  private row(owner: string, checkpointId: string) {
    const row = this.db
      .prepare('SELECT * FROM canvas_checkpoints WHERE id=? AND owner_id=?')
      .get(checkpointId, owner) as CheckpointRow | undefined
    if (!row) throw new CheckpointError('not_found', '检查点不存在')
    return row
  }
  private metadata(row: CheckpointRow): CanvasCheckpoint {
    const refs = checkpointAssetIds(
      row.state,
      (asset) => !!this.deps.assets.get(row.owner_id, asset),
    )
    const absent = refs.ids.filter((asset) => !existsSync(this.deps.assets.originalPath(asset)))
    return {
      id: row.id,
      projectId: row.project_id,
      sourceCanvasId: row.source_canvas_id,
      sourceCanvasTitle: row.source_canvas_title,
      name: row.name,
      createdAt: row.created_at,
      assets: refs.ids.length,
      missingAssets: [...new Set([...refs.missing, ...absent])],
    }
  }

  create(owner: string, canvasId: string, request: CreateCheckpoint): CanvasCheckpoint {
    const canvas = this.db
      .prepare('SELECT project_id,title FROM canvases WHERE id=? AND owner_id=?')
      .get(canvasId, owner) as { project_id: string; title: string } | undefined
    if (!canvas) throw new CheckpointError('not_found', '画布不存在')
    let expected: Y.Snapshot
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(request.expectedSnapshot)) throw new Error()
      expected = Y.decodeSnapshot(Buffer.from(request.expectedSnapshot, 'base64'))
    } catch {
      throw new CheckpointError('invalid', '检查点同步凭据无效')
    }
    const lease = this.deps.rooms.acquire(canvasId)
    const copy = new Y.Doc()
    let doc: ReturnType<typeof createDoc> | undefined
    try {
      // 从核对到编码之间没有 await，编辑、删除和生成写回无法插入其中。
      if (!includesSnapshot(Y.snapshot(lease.room.doc), expected))
        throw new CheckpointError('sync_pending', '本机编辑尚未同步，请等待连接恢复后重试保存')
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(lease.room.doc))
      doc = createDoc(copy, { schedule: () => {} })
      if (doc.readOnly)
        throw new CheckpointError('unsupported_version', '请升级 Plein 后再保存这张画布的检查点')
      const runIds = new Set<string>()
      copy.transact(() => {
        for (const el of doc!.elements()) {
          if (el.run) doc!.mutable(el.id)!.delete('run')
          for (const result of el.results ?? []) runIds.add(result.runId)
        }
      })
      const history: PackageJob[] = []
      for (const runId of runIds) {
        const job = this.db
          .prepare('SELECT * FROM jobs WHERE id=? AND owner_id=? AND canvas_id=?')
          .get(runId, owner, canvasId) as Record<string, unknown> | undefined
        if (!job) continue
        history.push({
          id: runId,
          canvasId,
          nodeId: job.node_id as string,
          nodeType: job.node_type as string,
          status:
            job.status === 'succeeded'
              ? 'succeeded'
              : job.status === 'failed'
                ? 'failed'
                : 'canceled',
          attempts: job.attempts as number,
          cacheKey: job.cache_key as string | null,
          cacheOmit: job.cache_omit as string | null,
          ...(job.input ? { input: JSON.parse(job.input as string) } : {}),
          error: null,
          createdAt: job.created_at as number,
          startedAt: job.started_at as number | null,
          finishedAt: (job.finished_at as number | null) ?? Date.now(),
        })
      }
      const state = Buffer.from(Y.encodeStateAsUpdate(copy))
      const row: CheckpointRow = {
        id: id('cp'),
        owner_id: owner,
        project_id: canvas.project_id,
        source_canvas_id: canvasId,
        source_canvas_title: canvas.title,
        name: request.name,
        state,
        history: JSON.stringify(history),
        created_at: Date.now(),
        content_hash: sha(state),
      }
      const refs = checkpointAssetIds(state, (asset) => !!this.deps.assets.get(owner, asset))
      this.db.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO canvas_checkpoints(id,owner_id,project_id,source_canvas_id,source_canvas_title,name,state,history,created_at,content_hash) VALUES(@id,@owner_id,@project_id,@source_canvas_id,@source_canvas_title,@name,@state,@history,@created_at,@content_hash)',
          )
          .run(row)
        const pin = this.db.prepare(
          'INSERT INTO checkpoint_assets(checkpoint_id,owner_id,asset_id) VALUES(?,?,?)',
        )
        for (const asset of refs.ids) pin.run(row.id, owner, asset)
        this.deps.index.refreshCheckpoint(row.id)
      })()
      return this.metadata(row)
    } finally {
      doc?.destroy()
      copy.destroy()
      lease.release()
    }
  }

  list(owner: string, projectId: string, query: CheckpointQuery): CheckpointPage {
    if (!this.db.prepare('SELECT id FROM projects WHERE id=? AND owner_id=?').get(projectId, owner))
      throw new CheckpointError('not_found', '项目不存在')
    const conditions = ['owner_id=?', 'project_id=?'],
      args: unknown[] = [owner, projectId]
    if (query.canvasId) {
      conditions.push('source_canvas_id=?')
      args.push(query.canvasId)
    }
    if (query.cursor) {
      try {
        const c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
        if (
          c.owner !== owner ||
          c.project !== projectId ||
          c.canvas !== (query.canvasId ?? '') ||
          !Number.isSafeInteger(c.at) ||
          typeof c.id !== 'string'
        )
          throw new Error()
        conditions.push('(created_at<? OR (created_at=? AND id<?))')
        args.push(c.at, c.at, c.id)
      } catch {
        throw new CheckpointError('invalid', '检查点分页游标无效')
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM canvas_checkpoints WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...args, query.limit + 1) as CheckpointRow[]
    const shown = rows.slice(0, query.limit),
      last = shown.at(-1)
    return {
      items: shown.map((r) => this.metadata(r)),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                owner,
                project: projectId,
                canvas: query.canvasId ?? '',
                at: last.created_at,
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    }
  }

  detail(owner: string, checkpointId: string): CheckpointDetail {
    const row = this.row(owner, checkpointId)
    return { ...this.metadata(row), state: Buffer.from(row.state).toString('base64') }
  }
  remove(owner: string, checkpointId: string) {
    this.row(owner, checkpointId)
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM canvas_checkpoints WHERE id=? AND owner_id=?')
        .run(checkpointId, owner)
      this.deps.index.refreshCheckpoint(checkpointId)
    })()
  }

  restore(owner: string, checkpointId: string, title?: string): CheckpointRestored {
    const row = this.row(owner, checkpointId)
    const ydoc = new Y.Doc()
    let doc: ReturnType<typeof createDoc> | undefined
    try {
      Y.applyUpdate(ydoc, row.state)
      doc = createDoc(ydoc, { schedule: () => {} })
      if (doc.readOnly)
        throw new CheckpointError('unsupported_version', '请升级 Plein 后再恢复这个检查点')
      const history = JSON.parse(row.history) as PackageJob[]
      const remap = new Map<string, string>()
      for (const el of doc.elements())
        for (const result of el.results ?? [])
          if (!remap.has(result.runId)) remap.set(result.runId, id('run'))
      ydoc.transact(() => {
        for (const el of doc!.elements()) {
          const m = doc!.mutable(el.id)!
          m.delete('run')
          if (el.results?.length)
            m.set(
              'results',
              el.results.map((r): NodeResult => ({ ...r, runId: remap.get(r.runId)! })),
            )
          const library = el.params?.libraryId
          if (
            typeof library === 'string' &&
            !this.db
              .prepare('SELECT id FROM library_items WHERE id=? AND owner_id=?')
              .get(library, owner)
          )
            (m.get('params') as Y.Map<unknown>)?.delete('libraryId')
        }
      })
      const canvasId = newCanvasId(),
        now = Date.now()
      const state = Buffer.from(Y.encodeStateAsUpdate(ydoc))
      this.db.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO canvases(id,owner_id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            canvasId,
            owner,
            row.project_id,
            title ?? `${row.source_canvas_title} · ${row.name}`.slice(0, 200),
            now,
            now,
          )
        this.db
          .prepare('INSERT INTO doc_updates(canvas_id,data,created_at) VALUES(?,?,?)')
          .run(canvasId, state, now)
        const put = this.db.prepare(
          "INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,attempts,cache_key,cache_omit,input,error,created_at,started_at,finished_at,calls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')",
        )
        for (const job of history) {
          const fresh = remap.get(job.id)
          if (fresh)
            put.run(
              fresh,
              owner,
              canvasId,
              job.nodeId,
              job.nodeType,
              job.status,
              job.attempts,
              job.cacheKey,
              job.cacheOmit,
              job.input === undefined ? null : JSON.stringify(job.input),
              null,
              job.createdAt,
              job.startedAt,
              job.finishedAt ?? now,
            )
        }
        this.db
          .prepare('UPDATE projects SET updated_at=? WHERE id=? AND owner_id=?')
          .run(now, row.project_id, owner)
        this.deps.index.refreshCanvas(canvasId)
        for (const fresh of remap.values()) this.deps.index.refreshJob(fresh)
      })()
      return { canvasId }
    } finally {
      doc?.destroy()
      ydoc.destroy()
    }
  }
}
