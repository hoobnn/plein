import {
  applyCast as applyCastIn,
  type CastOptions,
  castOf as castOfIn,
  defaultSpeech,
} from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import type { CastEntry } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { assetMetaNow, loadAssetMeta } from '../stores/assetMeta'
import { useLibrary } from '../features/library/store'
import { localContext } from './capabilities'
import { nodeFactory } from './nodes'

export { describeCast } from '@plein/capabilities'

/** 节点当前采用的文本结果；不是文本节点或还没跑过时为空 */
export const castOf = (engine: Engine, id: string) => castOfIn(engine.doc, id)

/** 按抽取结果建设定卡（逻辑见 @plein/capabilities），整个操作是一步撤销 */
export function applyCast(
  engine: Engine,
  catalog: Catalog | null,
  sourceId: string,
  entries: CastEntry[],
  library?: CastOptions['library'],
) {
  const r = applyCastIn(engine.doc, nodeFactory(catalog), sourceId, entries, {
    speech: defaultSpeech(localContext(engine, catalog)),
    library,
  })
  // 套用了资产库条目的记一次使用，资产库「最近使用」里排前面
  if (library)
    for (const id of r.created) {
      const libraryId = engine.doc.get(id)?.params?.libraryId
      if (typeof libraryId === 'string') useLibrary.getState().markUsed(libraryId)
    }
  return r
}

/**
 * 生成设定卡前备好资产库：没加载过先加载，同名条目的参考图尺寸先取回来（排版用）。
 * 资产库读不到（本地演示）时返回空，照常新建卡片。
 */
export async function castLibrary(entries: CastEntry[]): Promise<CastOptions['library']> {
  if (!useLibrary.getState().loaded) await useLibrary.getState().load()
  const { items, projectId } = useLibrary.getState()
  const names = new Set(entries.map((e) => e.name))
  await Promise.all(
    items
      .filter((i) => names.has(i.name))
      .flatMap((i) => i.images.map((img) => loadAssetMeta(img.assetId).catch(() => null))),
  )
  return { items, projectId, assetMeta: assetMetaNow }
}
