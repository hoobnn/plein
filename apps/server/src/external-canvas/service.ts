import { randomUUID } from 'node:crypto'
import type {
  ExternalApply,
  ExternalPlatform,
  ExternalPreview,
  ExternalPullNew,
  ExternalTarget,
} from '@plein/protocol'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { pullRows } from './pull'
import { canonicalTarget } from './targets'
import { ProjectQueue } from './project-queue'
import { makePlan, same } from './plan'
import type { CanvasProvider } from './provider'
import { linkStore } from './store'

export class SyncConflict extends Error {}
const stale = () => new SyncConflict('两端内容或绑定关系已变化，请刷新预览后重新选择。')
type AppliedRow = { rowId: string; localId: string | null; remoteId: string | null }
type SyncResult = ExternalPreview & { applied?: AppliedRow[] }

export function externalService(
  db: DB,
  rooms: Rooms,
  providers: Record<ExternalPlatform, CanvasProvider>,
  queue = new ProjectQueue(),
) {
  const preview = queue.reader<ExternalPreview>()
  const inspect = queue.reader<ExternalPreview>()
  async function run(
    canvasId: string,
    ref: ExternalTarget,
    apply?: ExternalApply | ExternalPullNew,
    options: { inspectOnly?: boolean; expectTarget?: string } = {},
  ): Promise<SyncResult> {
    ref = canonicalTarget(ref)
    const sync = async () => {
      const provider = providers[ref.provider]
      const store = linkStore(db, canvasId)
      if (rooms.wasDropped(canvasId)) throw new SyncConflict('Plein 画布已删除')
      const target = (await provider.resolveTarget?.(ref.target)) ?? ref.target
      if (options.expectTarget && options.expectTarget !== target) throw stale()
      // Older unqualified bindings did not record a space. Keep them accessible through
      // their original entry, without silently adopting them into another team's project.
      if (target !== ref.target && !store.list(ref).length) ref = { ...ref, target }
      const location = { ...ref, ...(target !== ref.target ? { resolvedTarget: target } : {}) }
      const links = store.list(ref)
      const selectedLink =
        apply && 'action' in apply && ['pull', 'push', 'merge'].includes(apply.action)
          ? links.find((link) => 'local/' + link.localId === apply.rowId)
          : undefined
      const items =
        selectedLink?.remoteId && provider.read
          ? [await provider.read(target, selectedLink.remoteId)]
          : await provider.list(target)
      if (rooms.wasDropped(canvasId)) throw new SyncConflict('Plein 画布已删除')
      const byId = new Map(items.map((item) => [item.id, item]))
      const operations = new Map(items.filter((i) => i.operationId).map((i) => [i.operationId, i]))
      // Only the editor's normal refresh maintains unrelated bindings. A rejected or partially
      // selected write, like an agent's read-only inspection, must leave the other rows alone.
      const maintainBindings = !apply && !options.inspectOnly
      if (operations.size !== items.filter((i) => !!i.operationId).length)
        throw new SyncConflict('即梦返回了重复的创建标记，请核对项目内的副本')
      // A timeout after remote creation leaves a durable intent. Only an exact provider identity
      // can recover it automatically. Titles and identical prompts are not identities.
      for (const link of links) {
        if (link.remoteId) continue
        const item =
          operations.get(link.operationId) ?? byId.get(provider.createdId?.(link.operationId) ?? '')
        if (item) {
          link.remoteId = item.id
          if (maintainBindings) store.save(link)
        }
      }
      // An existing linked item's position capability comes from that item itself.
      const createAtPosition = !selectedLink && !!(await provider.canCreateAtPosition?.())
      const rows = rooms.withDoc(canvasId, (doc) => {
        if (doc.readOnly && apply) throw new SyncConflict('此版本画布仅支持查看')
        return makePlan(
          { ...ref, target },
          canvasId,
          doc.elements(),
          items,
          links,
          provider.create ? (provider.createKinds ?? ['text']) : [],
          createAtPosition,
        )
      })
      const linkByLocal = new Map(links.map((l) => [l.localId, l]))
      // When the two sides independently converged this is their new common ancestor.
      for (const row of rows) {
        if (row.state !== 'synced' || !row.local) continue
        const link = linkByLocal.get(row.localId!)!
        if (maintainBindings && !same(link.baseline, row.local))
          store.save({ ...link, baseline: row.local })
      }
      if (!apply) return { ...location, rows }
      if ('rows' in apply) {
        const byRow = new Map(rows.map((row) => [row.rowId, row]))
        const selected = apply.rows.map((input) => {
          const row = byRow.get(input.rowId)
          if (
            !row ||
            row.revision !== input.revision ||
            row.state !== 'remote-only' ||
            !row.remote ||
            !row.remoteId
          )
            throw stale()
          return row
        })
        if (new Set(selected.map((row) => row.rowId)).size !== selected.length) throw stale()
        const applied = pullRows(db, rooms, canvasId, ref, selected)
        return { ...location, rows: [], applied }
      }
      const row = rows.find((r) => r.rowId === apply.rowId)
      if (!row || row.revision !== apply.revision || !row.actions.includes(apply.action))
        throw stale()
      const link = linkByLocal.get(row.localId!)
      const item = byId.get(row.remoteId ?? '')
      const changed: AppliedRow = { rowId: row.rowId, localId: row.localId, remoteId: row.remoteId }
      if (apply.action === 'unlink' && link) store.forget(ref, link.localId)
      else if (apply.action === 'reconcile' && link) {
        const match = byId.get(apply.remoteId ?? '')
        if (
          !match ||
          match.kind !== row.kind ||
          (match.operationId !== undefined && match.operationId !== link.operationId) ||
          (provider.createdId && match.id !== provider.createdId(link.operationId)) ||
          links.some((l) => l.remoteId === match.id) ||
          match.fields.title !== link.baseline.title ||
          match.fields.text !== link.baseline.text
        )
          throw new SyncConflict('所选节点已关联或与发出的标题、正文不符')
        store.save({ ...link, remoteId: match.id })
        changed.remoteId = match.id
      } else if (apply.action === 'pull' && item && row.remote) {
        changed.localId = pullRows(db, rooms, canvasId, ref, [row])[0]!.localId
      } else if (
        apply.action === 'merge' &&
        item &&
        link &&
        row.merged &&
        row.local &&
        row.remote
      ) {
        if (!same(row.remote, row.merged)) {
          await provider.update(target, item, row.merged)
          // The editor can keep receiving Yjs changes while the remote save is in flight.
          // Leave the common ancestor intact if a newer local edit now needs review.
          if (rooms.wasDropped(canvasId)) throw stale()
          const fresh = rooms.withDoc(canvasId, (doc) => {
            const local = doc.get(link.localId)
            if (doc.readOnly || !local) return
            return makePlan({ ...ref, target }, canvasId, [local], [item], [link], [], false)[0]
          })
          if (fresh?.revision !== row.revision)
            throw new SyncConflict('即梦已保存合并内容。Plein 在保存期间有新改动，请刷新后核对。')
        }
        if (same(row.local, row.merged)) store.updateBaseline(ref, link.localId, row.merged)
        else pullRows(db, rooms, canvasId, ref, [{ ...row, remote: row.merged }])
      } else if (apply.action === 'push' && row.local && row.localId) {
        const fields = row.local
        if (item && link) {
          await provider.update(target, item, fields)
          if (!rooms.wasDropped(canvasId)) store.save({ ...link, baseline: fields })
        } else if (!link && provider.create) {
          const intent = {
            ...ref,
            canvasId,
            localId: row.localId,
            operationId: randomUUID(),
            baseline: fields,
          }
          await provider.validateCreate?.(fields, row.kind)
          if (rooms.wasDropped(canvasId)) throw stale()
          store.save(intent)
          const remoteId = await provider.create(target, fields, intent.operationId, row.kind)
          changed.remoteId = remoteId
          if (!rooms.wasDropped(canvasId)) store.save({ ...intent, remoteId })
        } else throw stale()
      } else throw stale()
      return { ...location, rows: [], applied: [changed] }
    }
    if (apply) return queue.run(ref, sync)
    return (options.inspectOnly ? inspect : preview)(canvasId, ref, sync)
  }
  return {
    run,
    targets: (canvasId: string) => linkStore(db, canvasId).targets(),
    spaces: async (platform: ExternalPlatform) => {
      const provider = providers[platform]
      if (!provider.spaces) throw new Error('此平台不支持空间列表。')
      return provider.spaces()
    },
    projects: async (platform: ExternalPlatform, space?: string) => {
      const provider = providers[platform]
      if (space !== undefined && !provider.spaces) throw new Error('此平台不支持按空间选择项目。')
      return provider.projects?.(space) ?? []
    },
  }
}
