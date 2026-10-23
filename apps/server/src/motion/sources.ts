import { CompositionSourceRef } from '@plein/plugin-sdk'
import type { PleinDoc } from '@plein/doc'
import type { AssetStore } from '../assets/store'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { canvasState, readDocument } from '../media-index/references'

export interface MotionAssetSource {
  compositionSource: CompositionSourceRef
  title: string
}

/** 内容相同的MP4可能有多个源版本，按manifest身份枚举，供用户明确选择。 */
export async function motionAssetSources(
  deps: { assets: AssetStore; db: DB; rooms: Rooms },
  owner: string,
  assetId: string,
): Promise<MotionAssetSource[]> {
  if (!deps.assets.get(owner, assetId)) throw new Error('素材不存在')
  const choices = new Map<string, CompositionSourceRef>()
  const add = (value: unknown) => {
    if (value === undefined) return
    const source = CompositionSourceRef.parse(value)
    choices.set(source.manifestAssetId, source)
    if (choices.size > 100) throw new Error('动态合成源版本过多，请从具体画布或检查点选择')
  }
  const scan = (doc: PleinDoc) => {
    for (const element of doc.elements()) {
      if (element.assetId === assetId) add(element.params?.compositionSource)
      for (const result of element.results ?? [])
        if ('assetId' in result.value && result.value.assetId === assetId)
          add(result.value.compositionSource)
    }
  }
  const rows = deps.db.$client
    .prepare('SELECT id FROM canvases WHERE owner_id=? ORDER BY created_at DESC')
    .all(owner) as { id: string }[]
  for (const row of rows) readDocument(canvasState(deps.db, deps.rooms, row.id), scan)
  // 命名检查点在原节点或画布删除后仍保护素材及源版本。
  const checkpoints = deps.db.$client
    .prepare(`
    SELECT c.state FROM canvas_checkpoints c
    JOIN checkpoint_assets a ON a.checkpoint_id=c.id AND a.owner_id=c.owner_id
    WHERE c.owner_id=? AND a.asset_id=? ORDER BY c.created_at DESC
  `)
    .iterate(owner, assetId) as Iterable<{ state: Uint8Array }>
  for (const checkpoint of checkpoints) readDocument(checkpoint.state, scan)
  const library = deps.db.$client
    .prepare('SELECT data FROM library_items WHERE owner_id=?')
    .iterate(owner) as Iterable<{ data: string }>
  for (const row of library) {
    const item = JSON.parse(row.data) as { video?: unknown; videoCompositionSource?: unknown }
    if (item.video === assetId) add(item.videoCompositionSource ?? undefined)
  }
  const output: MotionAssetSource[] = []
  for (const source of choices.values()) {
    const ids = [source.bundleAssetId, source.manifestAssetId, ...source.dependencyAssetIds]
    // 来源声明存在就不能静默退化成无来源素材；调用方保留当前选择并显示错误。
    for (const id of ids) await deps.assets.verifyOriginal(owner, id)
    const manifestAsset = deps.assets.get(owner, source.manifestAssetId)!
    if (manifestAsset.size > 1024 * 1024) throw new Error('动态合成来源清单过大')
    const manifest = JSON.parse(
      new TextDecoder().decode(await deps.assets.readOriginal(owner, source.manifestAssetId)),
    ) as { params?: { title?: unknown } }
    const title =
      typeof manifest.params?.title === 'string'
        ? manifest.params.title.slice(0, 120)
        : '动态合成源版本'
    output.push({ compositionSource: source, title })
  }
  return output
}
