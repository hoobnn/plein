import type { CanvasElement } from '@plein/doc'
import { matchLines, type Shot } from '@plein/nodes'
import type { ShotSource } from './storyboard'

/** 旧台词、清空的音效和脱离计划的节点可留历史，不再参与当前镜头的生成或验收。 */
export function activeShotNodes(shot: Shot, nodes: readonly CanvasElement[]): CanvasElement[] {
  const sourceOf = (node: CanvasElement) => node.params?.source as ShotSource | undefined
  const speeches = nodes.filter(
    (node) => sourceOf(node)?.role === 'speech' && !sourceOf(node)?.detached,
  )
  const lines = matchLines(
    speeches.map((node, i) => {
      const source = sourceOf(node)!
      return {
        id: node.id,
        dialogueId: source.dialogueId,
        line: source.line ?? i,
        text: String(source.plan?.params.text ?? node.params?.text ?? ''),
      }
    }),
    shot.dialogue,
  )
  return nodes.filter((node) => {
    const source = sourceOf(node)
    if (!source || source.detached) return false
    if (source.role === 'speech') {
      const index = lines.get(node.id)
      return index !== undefined && !!shot.dialogue[index]?.line.trim()
    }
    if (source.role === 'sfx') return !!shot.sfx.trim()
    return source.role === 'image' || source.role === 'video'
  })
}
