/**
 * 平台配置的脏检查：按键值比较，不受键顺序影响。
 *
 * 服务端回传的配置是它自己合并后的结果，键的顺序可能与本地编辑后的顺序不同
 * （例如删掉一个字段再重新填入，新键会被追加到末尾）。用 JSON.stringify 比较
 * 会把这种「值完全相同」的情况误判成未保存，用户点了保存也看不到变化。
 */

/** 两份设置的键值是否完全一致（键顺序无关） */
export function sameSettings(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true
  const left = a ?? {}
  const right = b ?? {}
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

/** 是否有未保存的改动：密钥填了内容，或设置值与已保存的不同 */
export function providerDirty(
  settings: Record<string, unknown>,
  saved: Record<string, unknown> | undefined,
  secrets: Record<string, string>,
  numberEditing: boolean,
): boolean {
  if (numberEditing) return true
  if (Object.values(secrets).some((value) => value !== '')) return true
  return !sameSettings(settings, saved)
}
