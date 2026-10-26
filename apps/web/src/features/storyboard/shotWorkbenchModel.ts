import { setParam, type PleinDoc } from '@plein/doc'

export const WORKBENCH_FIELDS = ['description', 'imagePrompt', 'motionPrompt', 'lighting'] as const
export type WorkbenchField = (typeof WORKBENCH_FIELDS)[number]
export interface WorkbenchDraft {
  boardId: string
  shotId: string
  source: string
  values: Record<WorkbenchField, string>
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
function rawShot(doc: PleinDoc, boardId: string, shotId: string) {
  const board = doc.get(boardId),
    rows = board?.params?.shots
  const matches =
    board?.nodeType === 'plein/storyboard' && Array.isArray(rows)
      ? rows.filter((v): v is Record<string, unknown> => object(v) && v.id === shotId)
      : []
  return matches.length === 1 ? matches[0] : undefined
}
export function workbenchDraft(
  doc: PleinDoc,
  boardId: string,
  shotId: string,
): WorkbenchDraft | undefined {
  const shot = rawShot(doc, boardId, shotId)
  if (!shot) return undefined
  return {
    boardId,
    shotId,
    source: JSON.stringify(shot),
    values: Object.fromEntries(
      WORKBENCH_FIELDS.map((key) => [key, typeof shot[key] === 'string' ? shot[key] : '']),
    ) as Record<WorkbenchField, string>,
  }
}
/** Only the reviewed target is patched; raw sibling and unknown fields survive. */
export function applyWorkbenchDraft(
  doc: PleinDoc,
  boardId: string,
  draft: WorkbenchDraft,
): boolean {
  if (doc.readOnly || draft.boardId !== boardId) return false
  const shot = rawShot(doc, boardId, draft.shotId),
    rows = doc.get(boardId)?.params?.shots
  if (!shot || JSON.stringify(shot) !== draft.source || !Array.isArray(rows)) return false
  if (!WORKBENCH_FIELDS.every((key) => typeof draft.values[key] === 'string')) return false
  const changes = Object.fromEntries(
    WORKBENCH_FIELDS.filter(
      (key) => draft.values[key] !== (typeof shot[key] === 'string' ? shot[key] : ''),
    ).map((key) => [key, draft.values[key]]),
  )
  if (!Object.keys(changes).length) return true
  doc.undo.stopCapturing()
  setParam(
    doc,
    boardId,
    'shots',
    rows.map((row) =>
      object(row) && row.id === draft.shotId
        ? {
            ...shot,
            ...changes,
            edited: true,
          }
        : row,
    ),
  )
  doc.undo.stopCapturing()
  return true
}
/** Real graph edges only. P06's declared state references are shown separately. */
export function workbenchDownstream(doc: PleinDoc, sourceIds: readonly string[]): string[] {
  const seen = new Set(sourceIds),
    queue = [...sourceIds],
    result: string[] = []
  const next = new Map<string, string[]>()
  for (const edge of doc.edges()) {
    const from = next.get(edge.from[0]) ?? []
    from.push(edge.to[0])
    next.set(edge.from[0], from)
  }
  for (let at = 0; at < queue.length; at++)
    for (const id of next.get(queue[at]!) ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(id)
      if (doc.has(id)) result.push(id)
    }
  return result
}
