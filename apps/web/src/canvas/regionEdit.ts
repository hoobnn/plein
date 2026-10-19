import type { Engine } from '@plein/canvas-core'
import { elementMedia, fitAspect, ReadOnlyDocError, setParam } from '@plein/doc'
import type { EditMask } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { deriveNode } from './presets'

/** 局部重绘节点（同能力多个时取内置的） */
export function regionEditNode(catalog: Catalog | null) {
  const list = (catalog?.nodes ?? []).filter(
    (n) => n.capability === 'image.edit' && n.inputs.some((p) => p.type === 'image'),
  )
  return list.find((n) => n.type.startsWith('plein/')) ?? list[0]
}

/**
 * 从一张图开始局部重绘：右边建一个局部重绘节点，原图连进去，画好的区域写进节点，
 * 然后聚焦提示词，写好要改成什么再生成
 */
export function startRegionEdit(
  engine: Engine,
  catalog: Catalog | null,
  sourceId: string,
  mask: EditMask,
  name: string,
): string | null {
  if (engine.doc.readOnly) throw new ReadOnlyDocError()
  const source = engine.doc.get(sourceId)
  if (!source) throw new Error('原图已经不在画布上了')
  if (!mask.sourceAssetId || elementMedia(source)?.assetId !== mask.sourceAssetId)
    throw new Error('原图已经变化，请重新画重绘区域')
  const node = regionEditNode(catalog)
  if (!node) return null
  const input = node.inputs.find((p) => p.type === 'image')!
  const id = deriveNode(engine, catalog, sourceId, node.type, {
    inputPort: input.id,
    name: `${name} · 局部重绘`,
  })
  if (id) {
    setParam(engine.doc, id, 'mask', mask)
    // 结果和原图同尺寸，卡片跟着原图的比例
    fitAspect(engine.doc, id, mask.width / mask.height)
  }
  return id
}
