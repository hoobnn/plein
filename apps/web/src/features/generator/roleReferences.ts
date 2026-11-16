import type { PreparedInput } from '@plein/protocol'

/** 节点上某个角色的参考图：同一角色在提示词里写几处（@叶舒、@叶舒/校服）也只算一个。 */
export interface RoleView {
  elementId: string
  name: string
  /** 各处引用可选的图并集，保持服务端给的顺序（卡片顺序在前） */
  available: string[]
  /** 各处引用实际送入的图（自动模式下就是自动挑中的那几张） */
  sent: string[]
  /** 用户明确选的图；undefined 是自动，空数组是仅文字 */
  picks: string[] | undefined
}

/** 节点参数里按角色元素 id 保存的明确选择 */
export function readPicks(params: Record<string, unknown> | undefined): Record<string, string[]> {
  const value = params?.referenceImagePicks
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string[]>)
    : {}
}

/** 把实际输入里的角色引用按元素 id 合并；名字优先取画布上的卡片名（引用名带档案项） */
export function roleViews(
  data: PreparedInput | null | undefined,
  picks: Record<string, string[]>,
  nameOf: (elementId: string) => string | undefined,
): RoleView[] {
  const roles = new Map<string, RoleView>()
  for (const ref of data?.refs ?? []) {
    if (ref.kind !== 'character' || (ref.media && ref.media !== 'image')) continue
    const role = roles.get(ref.elementId) ?? {
      elementId: ref.elementId,
      name: nameOf(ref.elementId) ?? ref.name,
      available: [],
      sent: [],
      picks: picks[ref.elementId],
    }
    for (const id of ref.available) if (!role.available.includes(id)) role.available.push(id)
    for (const id of ref.sent) if (!role.sent.includes(id)) role.sent.push(id)
    roles.set(ref.elementId, role)
  }
  return [...roles.values()]
}

/** 当前勾选的图：手动模式是用户选的，自动模式是自动挑中的；都只算还能选的 */
export const checkedImages = (role: RoleView) =>
  role.available.filter((id) => (role.picks ?? role.sent).includes(id))

/**
 * 点一张图后的新选择：自动模式以当前自动选中的图为起点，所以点一下只是加减这一张；
 * 结果按卡片顺序存，不按点击先后，重排或重开后图的次序不变。
 */
export function togglePick(role: RoleView, assetId: string): string[] {
  const next = new Set(checkedImages(role))
  if (!next.delete(assetId)) next.add(assetId)
  return role.available.filter((id) => next.has(id))
}
