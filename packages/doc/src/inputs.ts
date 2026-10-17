import type { PleinDoc } from './doc'
import type { Edge } from './types'

/** 顺序属于目标端口，与源节点的画布位置无关；并发同序号按边 ID 收敛。 */
export function compareInputOrder(a: Edge, b: Edge): number {
  if (a.order !== b.order) {
    if (!a.order) return 1
    if (!b.order) return -1
    return a.order < b.order ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function inputEdges(doc: PleinDoc, nodeId: string, portId?: string): Edge[] {
  return [...doc.edges()]
    .filter((e) => e.to[0] === nodeId && (portId === undefined || e.to[1] === portId))
    .sort(compareInputOrder)
}
