export interface GuidePreferences {
  collapsed: boolean
  boardId?: string
  trialShotId?: string
  sequenceId?: string
}
export const guideStorageKey = (canvasId: string) => `plein:creation-guide:v1:${canvasId}`

/** localStorage禁用时仅在本次打开有效，不影响画布同步。 */
export function readGuidePreferences(
  canvasId: string,
  storage?: Pick<Storage, 'getItem'>,
): GuidePreferences {
  const fallback: GuidePreferences = { collapsed: false }
  try {
    const raw: unknown = JSON.parse(
      (storage ?? localStorage).getItem(guideStorageKey(canvasId)) ?? 'null',
    )
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
    const data = raw as Record<string, unknown>
    return {
      collapsed: data.collapsed === true,
      ...(typeof data.boardId === 'string' ? { boardId: data.boardId } : {}),
      ...(typeof data.trialShotId === 'string' ? { trialShotId: data.trialShotId } : {}),
      ...(typeof data.sequenceId === 'string' ? { sequenceId: data.sequenceId } : {}),
    }
  } catch {
    return fallback
  }
}
export function writeGuidePreferences(
  canvasId: string,
  value: GuidePreferences,
  storage?: Pick<Storage, 'setItem'>,
) {
  try {
    ;(storage ?? localStorage).setItem(guideStorageKey(canvasId), JSON.stringify(value))
  } catch {
    /* 本机设置存不下时保留当前内存状态。 */
  }
}
