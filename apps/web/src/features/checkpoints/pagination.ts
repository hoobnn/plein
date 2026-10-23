import type { CheckpointPage } from '@plein/protocol'

/** 追加下一页：游标已过期时保持原列表，否则按检查点 id 合并相邻页的重叠条目。 */
export function mergeCheckpointPage(
  old: CheckpointPage,
  cursor: string,
  result: CheckpointPage,
): CheckpointPage {
  return old.nextCursor !== cursor
    ? old
    : {
        items: [
          ...new Map([...old.items, ...result.items].map((item) => [item.id, item])).values(),
        ],
        nextCursor: result.nextCursor,
      }
}
