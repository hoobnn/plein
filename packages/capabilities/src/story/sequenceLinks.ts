import type { CanvasElement, PleinDoc } from '@plein/doc'
import { SEQUENCE_TYPE } from '@plein/nodes'
import type { ShotSource } from './storyboard'

/** 调用方先限定当前镜头节点；声音接入配乐不等于镜头对白或音效关联。 */
export function linkedShotSequences(
  doc: PleinDoc,
  nodes: readonly CanvasElement[],
): CanvasElement[] {
  const active = new Map(nodes.map((node) => [node.id, node]))
  const ports: Partial<Record<ShotSource['role'], string>> = {
    video: 'clips',
    speech: 'dialogue',
    sfx: 'sfx',
  }
  const links = new Set(
    [...doc.edges()]
      .filter((edge) => {
        const source = active.get(edge.from[0])?.params?.source as ShotSource | undefined
        return !!source && ports[source.role] === edge.to[1]
      })
      .map((edge) => edge.to[0]),
  )
  return [...doc.elements()].filter((node) => node.nodeType === SEQUENCE_TYPE && links.has(node.id))
}
