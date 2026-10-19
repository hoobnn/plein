type Position = { id: string; x: number; y: number }

const byId = (a: Position, b: Position) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)

/** 用每行最上方的元素固定 80px 行界，避免相邻比较形成循环顺序。 */
export function boardReadingOrder<T extends Position>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x || byId(a, b))
  const rows: T[][] = []
  for (const item of sorted) {
    const row = rows.at(-1)
    if (row && item.y - row[0]!.y <= 80) row.push(item)
    else rows.push([item])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.y - b.y || byId(a, b)))
}
