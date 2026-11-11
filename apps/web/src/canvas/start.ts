import type { Engine } from '@plein/canvas-core'
import type { Catalog } from '@plein/protocol'
import { useCanvas } from '../stores/canvas'
import { dramaNotice, placeDramaTemplate } from './drama'
import { findNode, nodeElement, placeElement } from './nodes'
import { focusGenerator } from './presets'
import { openProviderSettings } from './runStatus'
import { DRAMA_START, takeStartNode } from './startQueue'

/** 新画布上铺短剧模板（首次启动引导的“从短剧模板开始”） */

/** 首页“快速开始”：新建画布后要放下的节点，打开画布时取走（同一页面内跳转，放内存即可） */

/** 在视口左上附近铺短剧模板：选中剧本、打开创作引导、适配视图并提示（空画布起点卡与首页意图共用） */
export function insertDramaTemplate(engine: Engine, catalog: Catalog) {
  const c = engine.camera.viewRect
  const r = placeDramaTemplate(engine, catalog, { x: c.x + 80, y: c.y + 80 })
  engine.zoomToFit()
  // 新分镜会挂载创作引导栏；等 React 完成布局后按新的可见区域再适配。
  // 用户已经移动视图或离开文档时，不让迟到的适配打断操作。
  const { x, y, zoom } = engine.camera
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (
        useCanvas.getState().engine === engine &&
        engine.camera.x === x &&
        engine.camera.y === y &&
        engine.camera.zoom === zoom &&
        r.frames.some((id) => engine.doc.get(id))
      )
        engine.zoomToFit()
    }),
  )
  useCanvas
    .getState()
    .notify(
      dramaNotice(r),
      r.noModel.length ? { label: '去设置启用', run: openProviderSettings } : undefined,
    )
  return r
}

/** 画布和节点目录都就绪后调用：在视口中央放下节点、选中并聚焦生成器 */
export function placeStartNode(engine: Engine, catalog: Catalog, canvasId: string) {
  const type = takeStartNode(canvasId)
  if (!type) return
  if (type === DRAMA_START) {
    insertDramaTemplate(engine, catalog)
    return
  }
  const node = findNode(catalog, type)
  if (!node) return
  const c = engine.camera.viewRect
  // 生成器默认在节点下方，节点放在视口中线偏上
  const id = placeElement(engine, nodeElement(node), { x: c.x + c.w / 2, y: c.y + c.h * 0.36 })
  focusGenerator(engine, id)
}
