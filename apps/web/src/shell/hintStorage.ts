const KEY = 'plein.shortcut-hint'

/** 提示条是否还没被关闭过；存储不可用时当作看过，宁可不提示也不每次打扰 */
export function shouldShowShortcutHint(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    return (storage ?? localStorage).getItem(KEY) !== '1'
  } catch {
    return false
  }
}

export function dismissShortcutHint(storage?: Pick<Storage, 'setItem'>) {
  try {
    ;(storage ?? localStorage).setItem(KEY, '1')
  } catch {}
}
