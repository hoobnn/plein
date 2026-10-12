import type { Engine } from '@plein/canvas-core'
import { connect, createElement, LOCAL_ORIGIN, type NewElement } from '@plein/doc'
import {
  dramaTemplate,
  type DramaElementSpec,
  type DramaTemplateSpec,
  missingCapabilities,
  pickCapabilityModel,
} from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { findNode, nodeElement } from './nodes'

/**
 * 把短剧模板铺到画布上：只建元素和连线，绝不触发任何节点运行（插入不花钱）。
 * 模板数据在 @plein/nodes（纯函数），这里只负责按 catalog 把节点声明落到文档里。
 */

export interface DramaPlaceResult {
  /** 新建的顶层 Frame，用来选中和缩放到 */
  frames: string[]
  created: number
  /** catalog 里没有的节点类型：骨架没铺全 */
  missing: string[]
  /** 缺的是可选卡片（道具 / 风格），不影响骨架 */
  optionalMissing: string[]
  /** 没有已启用模型支持的能力（中文名） */
  noModel: string[]
  /** 端口对不上的连线数（节点声明改过端口时会出现） */
  loose: number
}

const empty = (noModel: string[]): DramaPlaceResult => ({
  frames: [],
  created: 0,
  missing: [],
  optionalMissing: [],
  noModel,
  loose: 0,
})

/** 子元素在父分组里，坐标本来就是相对的；只有顶层要挪到落点 */
function offsetOf(
  spec: DramaElementSpec,
  byKey: Map<string, DramaElementSpec>,
  at: { x: number; y: number },
) {
  const parent = spec.parent ? byKey.get(spec.parent) : undefined
  return parent?.shape === 'frame' ? { x: 0, y: 0 } : at
}

/** 建父再建子：按层级排序即可，模板数据固定两层 */
function byDepth(elements: DramaElementSpec[]) {
  const byKey = new Map(elements.map((e) => [e.key, e]))
  const depth = (spec: DramaElementSpec) => {
    let d = 0
    for (let cur = spec; cur.parent; cur = byKey.get(cur.parent)!) {
      // 模板数据写错时不死循环
      if (++d > 8) break
    }
    return d
  }
  return [...elements].sort((a, b) => depth(a) - depth(b))
}

export function placeDramaTemplate(
  engine: Engine,
  catalog: Catalog | null,
  at: { x: number; y: number },
  template: DramaTemplateSpec = dramaTemplate(),
): DramaPlaceResult {
  const noModel = missingCapabilities(template, catalog?.providers)
  const result = empty(noModel)
  const { doc } = engine
  const byKey = new Map(template.elements.map((e) => [e.key, e]))
  const ids = new Map<string, string>()

  doc.ydoc.transact(() => {
    for (const spec of byDepth(template.elements)) {
      const parentId = (spec.parent && ids.get(spec.parent)) || null
      const { x, y } = offsetOf(spec, byKey, at)
      let id: string | undefined
      if (spec.shape === 'frame') {
        id = createElement(doc, {
          kind: 'frame',
          name: spec.title,
          parentId,
          x: spec.x + x,
          y: spec.y + y,
          w: spec.w,
          h: spec.h,
        })
      } else if (spec.type === 'markdown') {
        id = createElement(doc, {
          kind: 'markdown',
          name: spec.title,
          parentId,
          x: spec.x + x,
          y: spec.y + y,
          w: spec.w,
          h: spec.h,
          text: spec.text ?? '',
        })
      } else {
        // 端口和默认参数一律来自节点声明，模板只覆盖要改的
        const info = findNode(catalog, spec.type)
        if (!info) {
          // 可选卡片（道具 / 风格）没有就跳过，骨架缺节点才要提示
          const list = spec.optional ? result.optionalMissing : result.missing
          list.push(spec.type)
          continue
        }
        const base = nodeElement(info)
        const params = {
          ...base.params,
          // 模型 id 由 catalog 决定；挑不到就留空，界面上会提示去设置里启用
          ...(spec.capability
            ? { model: pickCapabilityModel(catalog?.providers, spec.capability) }
            : {}),
          ...spec.params,
        }
        id = createElement(doc, {
          ...base,
          name: spec.title,
          parentId,
          x: spec.x + x,
          y: spec.y + y,
          w: spec.w,
          h: spec.h,
          params,
        } as NewElement)
      }
      ids.set(spec.key, id)
      result.created++
      if (!parentId && spec.shape === 'frame') result.frames.push(id)
    }

    for (const e of template.edges) {
      const from = ids.get(e.from[0])
      const to = ids.get(e.to[0])
      if (!from || !to) continue
      if (!connect(doc, [from, e.from[1]], [to, e.to[1]])) result.loose++
    }
  }, LOCAL_ORIGIN)

  doc.flush()
  if (result.frames.length) {
    engine.selection.set(result.frames)
    engine.setTool('select')
  }
  return result
}

/** 铺完给用户的一句话提示：没铺全、缺卡片、缺模型都要说清楚，不用 null 表示一切正常 */
export function dramaNotice(r: DramaPlaceResult): string {
  if (!r.created) return '短剧模板没有铺出来：请先在设置里启用平台，刷新后重试'
  const notes: string[] = []
  if (r.missing.length) notes.push(`缺少节点 ${r.missing.join('、')}，骨架没铺全`)
  if (r.optionalMissing.length) notes.push(`没有 ${r.optionalMissing.join('、')} 卡，先跳过`)
  if (r.noModel.length)
    notes.push(`没有启用支持「${r.noModel.join('、')}」的模型，请到设置里启用后再运行`)
  const tail = notes.length ? `。${notes.join('；')}` : '：先跑剧本和分镜，双击分镜节点展开镜头'
  return `短剧模板已铺出 ${r.frames.length} 个分组、${r.created} 个元素${tail}`
}
