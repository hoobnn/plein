import { placeDramaTemplate as placeIn } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { type DramaTemplateSpec, dramaTemplate } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { nodeFactory } from './nodes'

export { type DramaPlaceResult, dramaNotice } from '@plein/capabilities'

/** 把短剧模板铺到画布上（只建不跑，逻辑见 @plein/capabilities），铺完选中新分组 */
export function placeDramaTemplate(
  engine: Engine,
  catalog: Catalog | null,
  at: { x: number; y: number },
  template: DramaTemplateSpec = dramaTemplate(),
) {
  const result = placeIn(
    engine.doc,
    nodeFactory(catalog),
    (capability) => catalog?.defaultModels[capability] ?? '',
    at,
    template,
  )
  if (result.frames.length) {
    engine.selection.set(result.frames)
    engine.setTool('select')
  }
  return result
}
