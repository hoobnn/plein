import type { PleinDoc } from '@plein/doc'
import { STORYBOARD_TYPE } from '@plein/nodes'

/** 两个入口共用来源名称；同名分镜按元素 ID 稳定编号。 */
export function storyboardLabels(doc: PleinDoc): ReadonlyMap<string, string> {
  const groups = new Map<string, string[]>()
  for (const el of doc.elements()) {
    if (el.kind !== 'node' || el.nodeType !== STORYBOARD_TYPE) continue
    const name = el.name?.trim() || '未命名分镜'
    const ids = groups.get(name) ?? []
    ids.push(el.id)
    groups.set(name, ids)
  }
  const labels = new Map<string, string>()
  for (const [name, ids] of groups) {
    ids.sort()
    ids.forEach((id, index) =>
      labels.set(id, ids.length > 1 ? `${name}（同名 ${index + 1}）` : name),
    )
  }
  return labels
}
