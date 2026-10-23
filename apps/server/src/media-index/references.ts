import {
  createDoc,
  adoptedResultIds,
  compositionAssetIds,
  continuityAssets,
  sequenceSegmentAssets,
  type PleinDoc,
} from '@plein/doc'
import { CompositionSourceRef } from '@plein/plugin-sdk'
import {
  SHOT_ANALYSIS_TYPE,
  shotAnalysisAssets,
  DELIVERY_CHECK_TYPE,
  deliveryCheckAssets,
  isAiAnalysisType,
  aiAnalysisAssets,
} from '@plein/nodes'
import * as Y from 'yjs'
import { derivationAssets } from '@plein/protocol'
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
    const derivedInputs = derivationAssets(el.params?.mediaDerivation)
    for (const assetId of derivedInputs)
      add(assetId, `media-derivation/${assetId}`, null, false, true)
    for (const assetId of sequenceSegmentAssets(el))
      add(assetId, `sequence-segment/${assetId}`, null, true, true)
    // 动态合成的源工程素材按显式来源登记
    if (['image', 'video', 'audio'].includes(el.kind)) {
      const source = CompositionSourceRef.safeParse(el.params?.compositionSource)
      if (source.success)
        for (const id of compositionAssetIds(source.data))
          add(id, `composition/${id}`, null, true, true)
    }
    const adopted = adoptedResultIds(el)
    for (const assetId of continuityAssets(el.production?.continuity))
      add(assetId, `production/continuity/${assetId}`, null, false, true)
    for (const r of el.results ?? []) {
      if ('assetId' in r.value) {
        add(r.value.assetId, `result/${r.id}`, r.id, adopted.has(r.id), true)
        // 合成结果带着自己的源工程素材一起登记
        for (const id of compositionAssetIds(r.value.compositionSource))
          add(id, `result/${r.id}/composition/${id}`, r.id, adopted.has(r.id), true)
      } else if (el.nodeType === SHOT_ANALYSIS_TYPE && r.value.type === 'json')
        for (const assetId of shotAnalysisAssets(r.value.value))
          add(assetId, `result/${r.id}/analysis/${assetId}`, r.id, adopted.has(r.id), true)
      else if (el.nodeType === DELIVERY_CHECK_TYPE && r.value.type === 'json')
        for (const assetId of deliveryCheckAssets(r.value.value))
          add(assetId, `result/${r.id}/delivery-check/${assetId}`, r.id, adopted.has(r.id), true)
      else if (isAiAnalysisType(el.nodeType) && r.value.type === 'json')
        for (const assetId of aiAnalysisAssets(r.value.value))
          add(assetId, `result/${r.id}/ai-analysis/${assetId}`, r.id, adopted.has(r.id), true)
    }
    for (const delivery of el.deliveries ?? [])
      add(
        delivery.assetId,
        `delivery/${delivery.id}`,
        delivery.resultId,
        adopted.has(delivery.resultId),
        true,
      )
    stringReferences(el.params, (id, path) => {
      if (derivedInputs.length && path.startsWith('/mediaDerivation/')) return
      // 场景视角图虽存放在参数里，仍是档案直接持有的素材，不是碰巧出现的哈希文本。
      const sceneViewImage =
        el.nodeType === 'plein/scene' &&
        /^\/sceneViews\/\d+\/(?:images\/\d+|panorama\/assetId)$/.test(path)
      add(id, `params${path}`, null, false, sceneViewImage)
    })
    if (el.kind === 'markdown')
      for (const assetId of aiAnalysisAssets(el.params?.aiDraftOrigin))
        add(assetId, `ai-draft-origin/${assetId}`, null, true, true)
  }
  return out
}

/** 保存与迁移时严格校验新来源合同；索引读取仍能容纳损坏的旧文档。 */
export function compositionReferences(doc: PleinDoc): string[] {
  const ids = new Set<string>()
  const add = (source: unknown) => {
    if (source === undefined) return
    const parsed = CompositionSourceRef.safeParse(source)
    if (!parsed.success) throw new Error('动态合成来源信息无效')
    for (const id of compositionAssetIds(parsed.data)) ids.add(id)
  }
  for (const element of doc.elements()) {
    if (['image', 'video', 'audio'].includes(element.kind)) add(element.params?.compositionSource)
    for (const result of element.results ?? [])
      if ('assetId' in result.value) add(result.value.compositionSource)
  }
  return [...ids]
}

/** 库中的参考视频来源是显式硬引用；没有声明来源的旧视频保持原有缺失策略。 */
export function libraryCompositionReferences(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const item = value as { video?: unknown; videoCompositionSource?: unknown }
  if (item.videoCompositionSource === undefined || item.videoCompositionSource === null) return []
  if (typeof item.video !== 'string' || !ASSET_HASH.test(item.video))
    throw new Error('动态合成来源没有参考视频')
  const source = CompositionSourceRef.parse(item.videoCompositionSource)
  return [...new Set([item.video, ...compositionAssetIds(source)])]
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
