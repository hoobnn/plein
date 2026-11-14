import { WORKBENCH_FIELDS, type WorkbenchDraft, type WorkbenchField } from './shotWorkbenchModel'

/** 单字段与整份草稿的本机上限：提示词够长，但别把工作台当成整画布备份。 */
export const WORKBENCH_DRAFT_MAX_FIELD = 8_000
export const WORKBENCH_DRAFT_MAX_TOTAL = 32_000
const KEY_PREFIX = 'plein:workbench-draft:v1'

export type WorkbenchDraftSave = 'saved' | 'too-large' | 'unavailable'

interface StoredDraft {
  source: string
  values: Record<WorkbenchField, string>
  savedAt: number
}

type StoredBoard = Record<string, StoredDraft>

export function workbenchDraftKey(canvasId: string, boardId: string) {
  return `${KEY_PREFIX}:${encodeURIComponent(canvasId)}:${encodeURIComponent(boardId)}`
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const values = raw.values
  if (
    typeof raw.source !== 'string' ||
    typeof raw.savedAt !== 'number' ||
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    !WORKBENCH_FIELDS.every(
      (field) => typeof (values as Record<string, unknown>)[field] === 'string',
    )
  )
    return false
  try {
    const source: unknown = JSON.parse(raw.source)
    return !!source && typeof source === 'object' && !Array.isArray(source)
  } catch {
    return false
  }
}

/** 存不下或坏数据都按空处理；写入时再覆盖，不让旧内容挡住新草稿。 */
function readBoard(key: string, storage?: Pick<Storage, 'getItem'>): StoredBoard | undefined {
  try {
    const raw = (storage ?? localStorage).getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const board: StoredBoard = {}
    for (const [shotId, entry] of Object.entries(parsed))
      if (isStoredDraft(entry)) board[shotId] = entry
    return board
  } catch {
    return undefined
  }
}

function writeBoard(
  key: string,
  board: StoredBoard,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
) {
  try {
    const target = storage ?? localStorage
    const entries = Object.entries(board)
    if (!entries.length) {
      target.removeItem(key)
      return
    }
    target.setItem(key, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* 存储不可用时由调用方提示，并保留本次打开中的内存草稿。 */
  }
}

function draftSize(draft: WorkbenchDraft) {
  return (
    WORKBENCH_FIELDS.reduce((size, field) => size + draft.values[field].length, 0) +
    draft.source.length
  )
}

/**
 * 读取某镜的本机草稿。正式分镜已删除、或草稿与正式字段一致（没有未保存内容）时
 * 顺手清掉这条记录，避免下次打开又把旧值当成待恢复草稿。
 */
export function readWorkbenchDraft(
  canvasId: string | null,
  boardId: string,
  shotId: string,
  formal: WorkbenchDraft | undefined,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): WorkbenchDraft | undefined {
  if (!canvasId) return undefined
  const key = workbenchDraftKey(canvasId, boardId)
  const board = readBoard(key, storage)
  const entry = board?.[shotId]
  if (!entry) return undefined
  const drop = () => {
    delete board![shotId]
    writeBoard(key, board!, storage)
  }
  if (!formal) {
    drop()
    return undefined
  }
  if (WORKBENCH_FIELDS.every((field) => entry.values[field] === formal.values[field])) {
    drop()
    return undefined
  }
  return {
    boardId,
    shotId,
    source: entry.source,
    values: { ...entry.values },
  }
}

/** 只存有未保存内容的草稿；写得下才返回 saved，调用方不得把失败当作已保存。 */
export function saveWorkbenchDraft(
  canvasId: string | null,
  draft: WorkbenchDraft,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  now = Date.now(),
): WorkbenchDraftSave {
  if (!canvasId) return 'unavailable'
  if (
    WORKBENCH_FIELDS.some((field) => draft.values[field].length > WORKBENCH_DRAFT_MAX_FIELD) ||
    draftSize(draft) > WORKBENCH_DRAFT_MAX_TOTAL
  )
    return 'too-large'
  const key = workbenchDraftKey(canvasId, draft.boardId)
  const board = readBoard(key, storage)
  // 读不出已有记录时不能拿空对象回写，否则会把其他镜头的草稿一起覆盖掉。
  if (!board) return 'unavailable'
  board[draft.shotId] = {
    source: draft.source,
    values: { ...draft.values },
    savedAt: now,
  }
  try {
    const target = storage ?? localStorage
    target.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(board))))
    return 'saved'
  } catch {
    return 'unavailable'
  }
}

export function discardWorkbenchDraft(
  canvasId: string | null,
  boardId: string,
  shotId: string,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
) {
  if (!canvasId) return
  const key = workbenchDraftKey(canvasId, boardId)
  const board = readBoard(key, storage)
  if (!board?.[shotId]) return
  delete board[shotId]
  writeBoard(key, board, storage)
}

/** 草稿是否还有没写进正式分镜的内容（用于决定存不存本机）。 */
export function workbenchDraftDirty(
  draft: WorkbenchDraft | undefined,
  formal: WorkbenchDraft | undefined,
) {
  if (!draft || !formal) return false
  return WORKBENCH_FIELDS.some((field) => draft.values[field] !== formal.values[field])
}
