import type { Engine } from '@plein/canvas-core'
import { elementPorts, inputEdges } from '@plein/doc'

/**
 * 画布参考的候选：别的节点上能接进本节点媒体口的输出。
 *
 * 排除三���：本节点自己、能接的端口已经占满（单入口）、
 * 同一个输出已经接过一次（避免重复引用）。
 */
export interface ReferenceCandidate {
  sourceId: string
  sourceName: string
  outputId: string
  /** 输出端口的类型，用来选图标 */
  outputType: string
  /** 接到本节点的端口标签 */
  portLabel: string
  portId: string
  portType: string
}

/** 候选按名字与端口标签搜索 */
export function filterReferenceCandidates(
  candidates: ReferenceCandidate[],
  query: string,
): ReferenceCandidate[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return candidates
  return candidates.filter((c) => `${c.sourceName} ${c.portLabel}`.toLocaleLowerCase().includes(q))
}

/** 列出能接进本节点的画布参考候选 */
export function referenceCandidates(
  engine: Engine,
  el: { id: string },
  media: Array<{ id: string; type: string; label: string; multiple?: boolean }>,
): ReferenceCandidate[] {
  const availablePorts = media.filter(
    (port) => port.multiple || !inputEdges(engine.doc, el.id, port.id).length,
  )
  return [...engine.doc.elements()].flatMap((source) =>
    source.id === el.id
      ? []
      : (elementPorts(source)?.outputs ?? []).flatMap((output) =>
          availablePorts
            .filter(
              (port) =>
                (port.type === output.type || port.type === 'any' || output.type === 'any') &&
                !inputEdges(engine.doc, el.id, port.id).some(
                  (edge) => edge.from[0] === source.id && edge.from[1] === output.id,
                ),
            )
            .map((port: { id: string; type: string; label: string; multiple?: boolean }) => ({
              sourceId: source.id,
              sourceName: source.name ?? source.id,
              outputId: output.id,
              outputType: output.type,
              portLabel: port.label,
              portId: port.id,
              portType: port.type,
            })),
        ),
  )
}
