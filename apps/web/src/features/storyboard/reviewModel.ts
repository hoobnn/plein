import { getCreativeReview, type CanvasElement, type CreativeReviewStatus } from '@plein/doc'
import type { Shot } from '@plein/nodes'
import { activeShotNodes, type ShotSource } from '@plein/capabilities'

/** 已删台词与清空的音效仍留历史，不能变成当前镜头的验收待办。 */
export const reviewNodesForShot = activeShotNodes

/** 空镜头、有缺项或尚未人工确认的产物均待审，运行成功不代表通过。 */
export function shotReviewStatus(
  nodes: readonly CanvasElement[],
  shot?: Shot,
): CreativeReviewStatus {
  const active = shot ? reviewNodesForShot(shot, nodes) : nodes
  const states = active.map((node) => getCreativeReview(node)?.status ?? 'pending')
  if (shot) {
    for (const role of [
      'image',
      'video',
      ...(shot.dialogue.some((line) => line.line.trim()) ? ['speech'] : []),
      ...(shot.sfx.trim() ? ['sfx'] : []),
    ])
      if (!active.some((node) => (node.params?.source as ShotSource)?.role === role))
        states.push('pending')
  }
  return states.includes('changes')
    ? 'changes'
    : states.length > 0 && states.every((s) => s === 'usable')
      ? 'usable'
      : 'pending'
}

export function nextPendingShot(
  shots: readonly Shot[],
  groups: ReadonlyMap<string, readonly CanvasElement[]>,
  after?: string,
): Shot | undefined {
  const at = shots.findIndex((shot) => shot.id === after)
  for (let i = 1; i <= shots.length; i++) {
    const shot = shots[(at + i) % shots.length]!
    if (shotReviewStatus(groups.get(shot.id) ?? [], shot) === 'pending') return shot
  }
  return undefined
}

/** 用真实媒体时长定义切点前后各一秒，短于一秒的镜头使用整段。 */
export function continuityWindow(
  duration: number,
  side: 'before' | 'after',
): { start: number; end: number } | undefined {
  if (!Number.isFinite(duration) || duration <= 0) return undefined
  return side === 'before'
    ? { start: Math.max(0, duration - 1), end: duration }
    : { start: 0, end: Math.min(1, duration) }
}
