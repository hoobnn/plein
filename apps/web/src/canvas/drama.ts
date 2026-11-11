import { placeDramaTemplate as placeIn } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { type DramaTemplateSpec, dramaTemplate } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { nodeFactory } from './nodes'

export { dramaNotice } from '@plein/capabilities'

/** 请求展开「创作下一步」引导（浮动面板展开，窄屏弹窗打开） */
export const OPEN_CREATION_GUIDE = 'plein:open-creation-guide'

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
    // 选中第一个该运行的节点（剧本，缺失时退到创意），并打开「创作下一步」
    const first = [result.ids.script, result.ids.idea].find((id) => id && engine.doc.get(id))
    engine.selection.set(first ? [first] : result.frames)
    engine.setTool('select')
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_CREATION_GUIDE))
  }
  return result
}
