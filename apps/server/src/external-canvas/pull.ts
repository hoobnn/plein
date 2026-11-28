import { randomUUID } from 'node:crypto'
import { createElements, updateElement } from '@plein/doc'
import type { ExternalRow, ExternalTarget } from '@plein/protocol'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { importCard, localCard, writeCardText } from './elements'
import { linkStore } from './store'

/** Revisions are checked before entering here. No asynchronous work between validation and the Yjs transaction. */
export function pullRows(
  db: DB,
  rooms: Rooms,
  canvasId: string,
  ref: ExternalTarget,
  rows: ExternalRow[],
) {
  const saved = rooms.withDoc(canvasId, (doc) => {
    const changes = rows.map((row) => {
      if (!row.remote || !row.remoteId) throw new Error('远端节点已移除，请刷新后核对')
      const localId = row.localId ?? randomUUID()
      const current = doc.get(localId)
      if (current && (!localCard(current) || current.locked))
        throw new Error('Plein 节点已锁定或类型发生变化')
      return {
        localId,
        remoteId: row.remoteId,
        fields: row.remote,
        kind: row.kind,
        current,
        isNew: !row.localId,
      }
    })
    // Reserve identities first. A crash before Yjs persistence leaves a recoverable missing-local link.
    db.transaction((tx) => {
      const store = linkStore(tx, canvasId)
      for (const change of changes)
        if (change.isNew)
          store.save({
            ...ref,
            canvasId,
            localId: change.localId,
            remoteId: change.remoteId,
            operationId: randomUUID(),
            baseline: change.fields,
          })
    })
    doc.ydoc.transact(() => {
      const right = Array.from(doc.elements()).reduce(
        (max, el) => (el.parentId ? max : Math.max(max, el.x + el.w + 32)),
        0,
      )
      const cards = changes.flatMap(({ localId, fields, kind, current }, index) => {
        if (current) {
          updateElement(doc, localId, { name: fields.title, ...fields.position })
          writeCardText(doc, current, fields.text)
          return []
        }
        return [
          {
            ...importCard(kind, fields),
            id: localId,
            x: right + (index % 4) * 448,
            y: Math.floor(index / 4) * 400,
            ...fields.position,
          },
        ]
      })
      if (cards.length) createElements(doc, cards)
    }, doc.origin)
    return changes
  })
  if (!rooms.get(canvasId).persistNow()) throw new Error('Plein 画布尚未写入数据库，请刷新后核对')
  const store = linkStore(db, canvasId)
  for (const { isNew, localId, fields } of saved)
    if (!isNew) store.updateBaseline(ref, localId, fields)
  return saved.map(({ localId, remoteId }, i) => ({ rowId: rows[i]!.rowId, localId, remoteId }))
}
