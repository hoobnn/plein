/**
 * 剪辑返工会话：记住“哪个片段的哪次返工草稿”，让关闭、切走或刷新后还能继续同一草稿和任务。
 * 只保存关系与选择，不复制候选、不按名称或文件 hash 猜来源。
 */

export type ReworkSound = '' | 'native' | 'voice' | 'mix'
export const REWORK_SOUNDS: ReadonlySet<string> = new Set(['', 'native', 'voice', 'mix'])
/** 本机记录保留 30 天；过期后重新开始，不拿旧关系套新片段。 */
export const REWORK_SESSION_TTL = 30 * 24 * 60 * 60 * 1000
const KEY_PREFIX = 'plein:rework-session:v1'

export interface ReworkSession {
  canvasId: string
  sequenceId: string
  clipInstanceId: string
  /** 创建草稿时的来源节点与输出端口，用于确认来源没有被换掉。 */
  sourceId: string
  port: string
  draftId: string
  /** 创建草稿时的剪辑实例快照；实例变了就不能直接替换。 */
  expected: string
  candidateId: string
  sound: ReworkSound
  savedAt: number
}

export function reworkSessionKey(canvasId: string, sequenceId: string, clipInstanceId: string) {
  return `${KEY_PREFIX}:${encodeURIComponent(canvasId)}:${encodeURIComponent(sequenceId)}:${encodeURIComponent(clipInstanceId)}`
}

function isSession(value: unknown): value is ReworkSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.canvasId === 'string' &&
    typeof raw.sequenceId === 'string' &&
    typeof raw.clipInstanceId === 'string' &&
    typeof raw.sourceId === 'string' &&
    typeof raw.port === 'string' &&
    typeof raw.draftId === 'string' &&
    typeof raw.expected === 'string' &&
    typeof raw.candidateId === 'string' &&
    typeof raw.sound === 'string' &&
    REWORK_SOUNDS.has(raw.sound) &&
    typeof raw.savedAt === 'number'
  )
}

/** 读本机返工会话；坏数据、跨画布或过期记录都清掉，不返回半份关系。 */
export function readReworkSession(
  canvasId: string,
  sequenceId: string,
  clipInstanceId: string,
  now = Date.now(),
  storage?: Pick<Storage, 'getItem' | 'removeItem'>,
): ReworkSession | undefined {
  const key = reworkSessionKey(canvasId, sequenceId, clipInstanceId)
  const target = storage ?? localStorage
  let parsed: unknown
  try {
    const raw = target.getItem(key)
    if (!raw) return undefined
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (
    !isSession(parsed) ||
    parsed.canvasId !== canvasId ||
    parsed.sequenceId !== sequenceId ||
    parsed.clipInstanceId !== clipInstanceId ||
    !Number.isFinite(parsed.savedAt) ||
    now - parsed.savedAt > REWORK_SESSION_TTL
  ) {
    try {
      target.removeItem(key)
    } catch {
      /* 读不到也删不掉时当作没有记录。 */
    }
    return undefined
  }
  return parsed
}

export function writeReworkSession(
  session: ReworkSession,
  storage?: Pick<Storage, 'setItem'>,
): boolean {
  try {
    ;(storage ?? localStorage).setItem(
      reworkSessionKey(session.canvasId, session.sequenceId, session.clipInstanceId),
      JSON.stringify(session),
    )
    return true
  } catch {
    /* 本机存储不可用时，本次打开中的会话仍然有效。 */
    return false
  }
}

export function clearReworkSession(
  canvasId: string,
  sequenceId: string,
  clipInstanceId: string,
  storage?: Pick<Storage, 'removeItem'>,
) {
  try {
    ;(storage ?? localStorage).removeItem(reworkSessionKey(canvasId, sequenceId, clipInstanceId))
  } catch {
    /* 删不掉也不影响当前页面继续使用。 */
  }
}
