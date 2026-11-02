import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  createDoc,
  createProductionGoals,
  readProductionGoals,
  remapProductionGoalScopes,
  copySourceMap,
  createSourceMap,
  readSourceMap,
  copyContinuity,
  createContinuityMap,
  readContinuity,
  remapSequenceCanvasScopes,
  snapshotTypedDeliveries,
  type NodeResult,
} from '@plein/doc'
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
import { CheckpointStore } from './store'
import { compositionReferences } from '../media-index/references'

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
  private store() {
    return new CheckpointStore(this.deps.db)
  }

  private row(owner: string, checkpointId: string) {
    const row = this.store().row(owner, checkpointId)
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

  private checkCompositionSources(owner: string, doc: ReturnType<typeof createDoc>) {
    try {
      for (const assetId of compositionReferences(doc)) {
        if (
          !this.deps.assets.get(owner, assetId) ||
          !existsSync(this.deps.assets.originalPath(assetId))
        )
          throw new Error('missing')
      }
    } catch {
      throw new CheckpointError('invalid', '动态合成源工程信息无效或依赖缺失，无法保存或恢复检查点')
    }
  }

  create(owner: string, canvasId: string, request: CreateCheckpoint): CanvasCheckpoint {
    const canvas = this.store().canvas(owner, canvasId)
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
      this.checkCompositionSources(owner, doc)
      const runIds = new Set<string>()
      copy.transact(() => {
        for (const el of doc!.elements()) {
          if (el.run) doc!.mutable(el.id)!.delete('run')
          for (const result of el.results ?? []) runIds.add(result.runId)
        }
      })
      const history: PackageJob[] = []
      for (const runId of runIds) {
        const job = this.store().job(owner, canvasId, runId) as Record<string, unknown> | undefined
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
      this.store().insert(row, refs.ids, () => this.deps.index.refreshCheckpoint(row.id))
      return this.metadata(row)
    } finally {
      doc?.destroy()
      copy.destroy()
      lease.release()
    }
  }

  list(owner: string, projectId: string, query: CheckpointQuery): CheckpointPage {
    if (!this.store().projectExists(owner, projectId))
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
    const rows = this.store().list(conditions, args, query.limit + 1)
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
    this.store().remove(owner, checkpointId, () => this.deps.index.refreshCheckpoint(checkpointId))
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
      this.checkCompositionSources(owner, doc)
      const history = JSON.parse(row.history) as PackageJob[]
      const remap = new Map<string, string>()
      const canvasId = newCanvasId()
      if (row.source_canvas_id) remap.set(row.source_canvas_id, canvasId)
      for (const el of doc.elements())
        for (const result of el.results ?? [])
          if (!remap.has(result.runId)) remap.set(result.runId, id('run'))
      ydoc.transact(() => {
        const localBindings = new Map([...doc!.elements()].map((el) => [el.id, el.id]))
        for (const el of doc!.elements()) {
          const m = doc!.mutable(el.id)!
          const checkParams = m.get('params')
          if (el.nodeType === 'plein/delivery-check' && checkParams instanceof Y.Map)
            checkParams.set('historical', true)
          if (
            el.nodeType === 'plein/sequence' &&
            checkParams instanceof Y.Map &&
            checkParams.get('instanceVersion') === 2
          )
            checkParams.set('clips', remapSequenceCanvasScopes(checkParams.toJSON(), remap).clips)
          const production = m.get('production')
          if (production instanceof Y.Map) {
            const goals = readProductionGoals(production.get('goals'))
            const remapped = remapProductionGoalScopes(goals, remap)
            if (remapped !== goals) production.set('goals', createProductionGoals(remapped))
            const sourceMap = readSourceMap(production.get('sourceMap'))
            if (sourceMap && (sourceMap.sources.length || sourceMap.proposals.length))
              production.set('sourceMap', createSourceMap(copySourceMap(sourceMap, localBindings)))
            const continuity = readContinuity(production.get('continuity'))
            if (
              continuity &&
              (continuity.subjects.length ||
                continuity.plans.length ||
                continuity.observations.length)
            )
              production.set(
                'continuity',
                createContinuityMap(copyContinuity(continuity, localBindings, remap)),
              )
          }
          m.delete('run')
          if (el.results?.length)
            m.set(
              'results',
              el.results.map((r): NodeResult => ({ ...r, runId: remap.get(r.runId)! })),
            )
          if (el.deliveries?.length)
            m.set(
              'deliveries',
              snapshotTypedDeliveries(
                el.deliveries.map((record) => ({ ...record, historical: true })),
              ),
            )
          const library = el.params?.libraryId
          if (typeof library === 'string' && !this.store().libraryItemExists(owner, library))
            (m.get('params') as Y.Map<unknown>)?.delete('libraryId')
        }
      })
      const now = Date.now()
      const state = Buffer.from(Y.encodeStateAsUpdate(ydoc))
      this.store().restore({
        owner,
        projectId: row.project_id,
        now,
        canvas: {
          id: canvasId,
          title: title ?? `${row.source_canvas_title} · ${row.name}`.slice(0, 200),
        },
        doc: { state },
        jobs: history.flatMap((job) => {
          const fresh = remap.get(job.id)
          return fresh
            ? [
                {
                  id: fresh,
                  nodeId: job.nodeId,
                  nodeType: job.nodeType,
                  status: job.status,
                  attempts: job.attempts,
                  cacheKey: job.cacheKey,
                  cacheOmit: job.cacheOmit,
                  input: job.input,
                  createdAt: job.createdAt,
                  startedAt: job.startedAt,
                  finishedAt: job.finishedAt,
                },
              ]
            : []
        }),
        within: () => {
          this.deps.index.refreshCanvas(canvasId)
          for (const fresh of remap.values()) this.deps.index.refreshJob(fresh)
        },
      })
      return { canvasId }
    } finally {
      doc?.destroy()
      ydoc.destroy()
    }
  }
}
