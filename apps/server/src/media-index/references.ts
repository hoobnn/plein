import { createDoc, currentResult, type PleinDoc } from '@plein/doc'
import * as Y from 'yjs'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'

export const ASSET_HASH = /^[0-9a-f]{64}$/

export interface AssetReference {
  assetId: string
  locator: string
  nodeId: string | null
  resultId: string | null
  label: string
  adopted: boolean
  explicit: boolean
}

/** 参数中的资产 ID 只在属于当前 owner 的真实资产存在时作为引用。 */
export function stringReferences(
  value: unknown,
  visit: (id: string, path: string) => void,
  path = '',
) {
  if (typeof value === 'string') {
    if (ASSET_HASH.test(value)) visit(value, path)
  } else if (Array.isArray(value)) {
    value.forEach((entry, i) => stringReferences(entry, visit, `${path}/${i}`))
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value))
      stringReferences(entry, visit, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)
  }
}

export function documentReferences(doc: PleinDoc): AssetReference[] {
  const out: AssetReference[] = []
  for (const el of doc.elements()) {
    const label = el.name ?? el.nodeType ?? el.kind
    const add = (
      assetId: string,
      locator: string,
      resultId: string | null,
      adopted: boolean,
      explicit: boolean,
    ) =>
      out.push({
        assetId,
        locator: `${el.id}/${locator}`,
        nodeId: el.id,
        resultId,
        label,
        adopted,
        explicit,
      })
    if (el.assetId) add(el.assetId, 'asset', null, true, true)
    const adopted = currentResult(el)?.id
    for (const r of el.results ?? [])
      if ('assetId' in r.value) add(r.value.assetId, `result/${r.id}`, r.id, r.id === adopted, true)
    for (const delivery of el.deliveries ?? [])
      add(
        delivery.assetId,
        `delivery/${delivery.id}`,
        delivery.resultId,
        delivery.resultId === adopted,
        true,
      )
    stringReferences(el.params, (id, path) => add(id, `params${path}`, null, false, false))
  }
  return out
}

/** 不打开新房间，优先读取现有房间中的未落盘编辑。调用者负责授权。 */
export function canvasState(db: DB, rooms: Rooms, canvasId: string): Uint8Array {
  if (rooms.has(canvasId)) return Y.encodeStateAsUpdate(rooms.get(canvasId).doc)
  const doc = new Y.Doc()
  try {
    const rows = db.$client
      .prepare('SELECT data FROM doc_updates WHERE canvas_id = ? ORDER BY id')
      .all(canvasId) as Array<{ data: Buffer }>
    for (const row of rows) Y.applyUpdate(doc, row.data)
    return Y.encodeStateAsUpdate(doc)
  } finally {
    doc.destroy()
  }
}

export function readDocument<T>(state: Uint8Array, read: (doc: PleinDoc) => T): T {
  const ydoc = new Y.Doc()
  let doc: PleinDoc | undefined
  try {
    Y.applyUpdate(ydoc, state)
    doc = createDoc(ydoc, { schedule: () => {} })
    return read(doc)
  } finally {
    doc?.destroy()
    ydoc.destroy()
  }
}
