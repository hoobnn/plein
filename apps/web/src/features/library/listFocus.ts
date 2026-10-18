/** null 表示查询框，undefined 表示保留用户当前焦点。 */
export function listFocusTarget(
  visible: string[],
  returning: string | null | undefined,
  previous: { id: string; index: number } | null,
  focusLost: boolean,
): string | null | undefined {
  if (returning !== undefined)
    return returning !== null && visible.includes(returning) ? returning : null
  if (!previous || !focusLost || visible.includes(previous.id)) return undefined
  return visible[Math.min(previous.index, visible.length - 1)] ?? null
}
