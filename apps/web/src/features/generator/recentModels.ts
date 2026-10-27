/**
 * 最近使用的模型：按当前用户分别记在本机。
 *
 * 记号里带着当前用户的 id：会话是异步就绪的，组件挂载时可能还没读到用户，
 * 这时如果用挂载那一刻的键去读、后来又用就绪后的键去写，读写就落在两个地方，
 * 「最近」里永远只剩刚选的那一个。这里把读写都收敛到同一个键上。
 */

const LIMIT = 6

/** 读取某个键下最近使用的模型；键读不出来时返回 null（与「没有记录」区分开） */
function readStored(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return []
    const stored: unknown = JSON.parse(raw)
    if (!Array.isArray(stored)) return []
    return stored.filter((v): v is string => typeof v === 'string').slice(0, LIMIT)
  } catch {
    return null
  }
}

/** 读取某个键下最近使用的模型，坏数据当作没有 */
export function readRecentModels(key: string): string[] {
  return readStored(key) ?? []
}

/**
 * 把一次选择写进最近列表：新的排最前，重复的只留最靠前的那次。
 * 以存储里的为准，不拿内存里的旧列表去补——两者可能属于不同的用户。
 */
export function pushRecentModel(key: string, ref: string): string[] {
  const stored = readStored(key) ?? []
  const next = [ref, ...stored.filter((r) => r !== ref)].slice(0, LIMIT)
  try {
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    /* 隐私模式不影响选择 */
  }
  return next
}

/** 最近使用的模型在本地存储里的键 */
export function recentModelsKey(principalId: string | undefined | null): string {
  return `plein:recent-models:${principalId ?? 'local'}`
}
