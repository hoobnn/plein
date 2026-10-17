/** 列表请求期间完成的本地写操作优先，避免旧快照撤销新增、更新或删除。条目按不可变方式更新。 */
export function reconcileList<T extends { id: string }>(
  fetched: T[],
  before: T[],
  current: T[],
  removed: ReadonlySet<string> = new Set(),
): T[] {
  const previous = new Map(before.map((item) => [item.id, item]))
  const present = new Set(current.map((item) => item.id))
  const changes = new Map(
    current.filter((item) => previous.get(item.id) !== item).map((item) => [item.id, item]),
  )
  const items = fetched.flatMap((item) => {
    if (removed.has(item.id) || (previous.has(item.id) && !present.has(item.id))) return []
    const changed = changes.get(item.id)
    changes.delete(item.id)
    return [changed ?? item]
  })
  return [...changes.values(), ...items]
}
