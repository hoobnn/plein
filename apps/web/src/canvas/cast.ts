import type { Engine } from '@plein/canvas-core'
import { createElement, currentResult, type NewElement, setParams } from '@plein/doc'
import { CAST_NODE_TYPES, type CastEntry, parseCast } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { findNode, mentionElements, nodeElement } from './nodes'

/** 节点当前采用的文本结果；不是文本节点或还没跑过时为空 */
export function castOf(engine: Engine, id: string): CastEntry[] {
  const el = engine.doc.get(id)
  const value = el && currentResult(el, 'text')?.value
  return value?.type === 'text' ? parseCast(value.text) : []
}

export interface CastResult {
  /** 新建的设定卡 */
  created: string[]
  /** 原来设定为空、这次补上的卡 */
  filled: string[]
  /** 已经写了设定的同名卡：不覆盖用户写的 */
  kept: string[]
  /** 画布上有重名、或同名的是别的类型：指不明，不动 */
  ambiguous: string[]
}

const COLUMN_GAP = 40
const ROW_GAP = 24

/**
 * 按抽取结果建设定卡：同名卡已存在时只给空设定补上，写过的不覆盖；
 * 新卡按角色 / 场景 / 道具分列，放在来源节点所在分组的右侧。整个操作是一步撤销。
 */
export function applyCast(
  engine: Engine,
  catalog: Catalog | null,
  sourceId: string,
  entries: CastEntry[],
): CastResult {
  const { doc } = engine
  const result: CastResult = { created: [], filled: [], kept: [], ambiguous: [] }
  const anchor = doc.ancestors(sourceId).at(-1)?.id ?? sourceId
  const rect = doc.worldRect(anchor)
  if (!rect) return result
  const byName = mentionElements(engine)
  const columns = new Map<string, { x: number; y: number }>()
  let nextX = rect.x + rect.w + 120

  doc.ydoc.transact(() => {
    for (const entry of entries) {
      const type = CAST_NODE_TYPES[entry.kind]
      const same = byName.get(entry.name) ?? []
      if (same.length > 1 || (same.length === 1 && same[0]!.nodeType !== type)) {
        result.ambiguous.push(entry.name)
        continue
      }
      const existing = same[0]
      if (existing) {
        if (String(existing.params?.description ?? '').trim()) result.kept.push(entry.name)
        else {
          setParams(doc, existing.id, { description: entry.description })
          result.filled.push(entry.name)
        }
        continue
      }
      const info = findNode(catalog, type)
      if (!info) continue
      const base = nodeElement(info)
      let col = columns.get(type)
      if (!col) {
        col = { x: nextX, y: rect.y }
        columns.set(type, col)
        nextX += base.w + COLUMN_GAP
      }
      const id = createElement(doc, {
        ...base,
        name: entry.name,
        x: Math.round(col.x),
        y: Math.round(col.y),
        params: { ...base.params, description: entry.description },
      } as NewElement)
      col.y += base.h + ROW_GAP
      byName.set(entry.name, [doc.get(id)!])
      result.created.push(id)
    }
  }, doc.origin)
  doc.flush()
  return result
}

export function describeCast(r: CastResult) {
  const parts = [
    r.created.length && `新建 ${r.created.length} 张设定卡`,
    r.filled.length && `补上 ${r.filled.join('、')} 的设定`,
    r.kept.length && `${r.kept.join('、')} 已有设定，没有覆盖`,
    r.ambiguous.length && `${r.ambiguous.join('、')} 在画布上重名，没有动`,
  ].filter(Boolean)
  return parts.length ? parts.join('；') : '抽取结果里没有可用的角色或场景'
}
