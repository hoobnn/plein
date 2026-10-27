import type { Engine } from '@plein/canvas-core'
import { fitAspect, videoAssetOf } from '@plein/doc'

/** 视频的宽高比；读不到尺寸时为 null */
export type RatioOf = (assetId: string) => Promise<number | null>

/**
 * 结果是视频的节点，卡片形状始终跟视频本身的宽高比一致：
 * 新结果到达、切换候选时在这里调整（长边和中心不动）。
 * 视频素材元素由引擎按封面比例自适应（Engine.fitMedia），这里不重复处理，免得两边取整不同来回改。
 * 每个客户端算出的结果相同，并发写入也不会来回抖。
 */
export function watchVideoAspect(engine: Engine, ratioOf: RatioOf) {
  const { doc } = engine
  const cache = new Map<string, { ratio: Promise<number | null>; refs: number }>()
  const sources = new Map<string, string>()
  let disposed = false

  const check = (id: string) => {
    const el = doc.get(id)
    const assetId = el?.kind === 'node' ? videoAssetOf(el) : undefined
    const previous = sources.get(id)
    if (previous !== assetId) {
      if (previous) {
        const entry = cache.get(previous)!
        if (--entry.refs === 0) cache.delete(previous)
        sources.delete(id)
      }
      if (assetId) {
        let entry = cache.get(assetId)
        if (!entry) {
          entry = { ratio: ratioOf(assetId).catch(() => null), refs: 0 }
          cache.set(assetId, entry)
        }
        entry.refs++
        sources.set(id, assetId)
      }
    }
    if (!assetId) return
    void cache.get(assetId)!.ratio.then((r) => {
      // 等尺寸期间结果可能又换了，按当前展示的视频为准
      if (disposed || !r || videoAssetOf(doc.get(id)) !== assetId) return
      fitAspect(doc, id, r)
    })
  }

  for (const el of doc.elements()) check(el.id)
  const off = doc.subscribe((change) => {
    for (const id of change.elements) check(id)
  })
  return () => {
    disposed = true
    off()
    sources.clear()
    cache.clear()
  }
}
