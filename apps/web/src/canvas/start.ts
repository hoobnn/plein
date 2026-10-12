import type { Engine } from '@plein/canvas-core'
import type { Catalog } from '@plein/protocol'
import { findNode, nodeElement, placeElement } from './nodes'
import { focusGenerator } from './presets'

/** 首页“快速开始”：新建画布后要放下的节点，打开画布时取走（同一页面内跳转，放内存即可） */
const pending = new Map<string, string>()

export function queueStartNode(canvasId: string, nodeType: string) {
  pending.set(canvasId, nodeType)
}

/** 画布和节点目录都就绪后调用：在视口中央放下节点、选中并聚焦生成器 */
export function placeStartNode(engine: Engine, catalog: Catalog, canvasId: string) {
  const type = pending.get(canvasId)
  if (!type) return
  pending.delete(canvasId)
  const node = findNode(catalog, type)
  if (!node) return
  const c = engine.camera.viewRect
  // 生成器默认在节点下方，节点放在视口中线偏上
  const id = placeElement(engine, nodeElement(node), { x: c.x + c.w / 2, y: c.y + c.h * 0.36 })
  focusGenerator(engine, id)
}
