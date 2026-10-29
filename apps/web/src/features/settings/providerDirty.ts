/**
 * 平台配置的脏检查：按键值比较，不受键顺序影响。
 *
 * 服务端回传的配置是它自己合并后的结果，键的顺序可能与本地编辑后的顺序不同
 * （例如删掉一个字段再重新填入，新键会被追加到末尾）。用 JSON.stringify 比较
 * 会把这种「值完全相同」的情况误判成未保存，用户点了保存也看不到变化。
 *
 * 配置里可以嵌套对象与数组（插件声明的设置结构），所以要比到值那一层：
 * 直接用 `===` 比较嵌套对象会按引用比，保存响应里同样的内容会被当成改动，
 * 面板就一直显示未保存并禁用连接检查。
 */

/** 两个值是否相等：对象与数组按键序无关地逐项比较 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameValue(item, b[index]))
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  )
}

/** 两份设置的键值是否完全一致（键顺序无关，嵌套结构也逐项比较） */
export function sameSettings(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  return sameValue(a ?? {}, b ?? {})
}

/** 是否有未保存的改动：密钥卡有草稿、设置值与已保存的不同，或正在编辑数字 */
export function providerDirty(
  settings: Record<string, unknown>,
  saved: Record<string, unknown> | undefined,
  cards: readonly CredentialCardDraft[],
  numberEditing: boolean,
): boolean {
  if (numberEditing) return true
  if (!sameSettings(settings, saved)) return true
  return cards.some(credentialCardDirty)
}

/** 一张密钥卡的草稿：key 是已保存组的 id，新卡用临时键 */
export interface CredentialCardDraft {
  key: string
  /** 标签输入；已保存组留空表示不修改 */
  label: string
  /** 密钥输入；已保存组留空表示不修改 */
  secrets: Record<string, string>
  /** 基线标签：已保存组是空串，新平台的预填卡是预填值；手动添加的新卡没有基线，总是未保存 */
  baseline?: string
}

/** 一张密钥卡是否有没保存的改动：没有基线的新卡总是算，其余改了标签或填了密钥才算 */
export function credentialCardDirty(card: CredentialCardDraft): boolean {
  if (card.baseline === undefined) return true
  return card.label.trim() !== card.baseline || Object.values(card.secrets).some((v) => v !== '')
}
