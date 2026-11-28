import { CapabilityError } from '@plein/capabilities'
import type { Rooms } from '../sync/rooms'
import type { UiCall, ViewState } from './tool-registry'

export function activeView(rooms: Rooms, canvasId: string) {
  if (!canvasId) return undefined
  let latest: { client: number; view: ViewState } | undefined
  for (const [client, state] of rooms.get(canvasId).awareness.getStates()) {
    const view = (state as { view?: ViewState }).view
    if (
      view &&
      Array.isArray(view.selection) &&
      view.viewport &&
      (!latest || view.at > latest.view.at)
    )
      latest = { client, view }
  }
  return latest
}

/** 视图请求只发给最近活跃的标签页；返回值表示已派发，目标页面可能仍在询问是否离开。 */
export function sendViewAction(
  rooms: Rooms,
  canvasId: string,
  call: UiCall | { action: 'open_canvas'; id: string },
) {
  const target = activeView(rooms, canvasId)
  if (!target) return false
  const awareness = rooms.get(canvasId).awareness
  const modern = target.view.uiVersion === 2
  if (!modern) {
    if (call.action === 'open_canvas') return false
    if (call.action === 'focus' && !call.ids.length)
      throw new CapabilityError('此窗口使用较早版本的 Plein，请刷新后再适应画布。')
    const legacy = [...awareness.getStates().values()].filter(
      (s) => s.view && s.view.uiVersion !== 2,
    )
    if (legacy.length > 1)
      throw new CapabilityError('有多个旧版窗口打开了这张画布。请刷新要操作的窗口后重试。')
  }
  // Old clients treat unknown actions as flyTo(ids) and ignore client targeting except for undo.
  const field = modern ? 'agentUiV2' : 'agentUi'
  const state = awareness.getLocalState() ?? {}
  const prev = (state[field] as { actions?: Array<{ n: number }> } | undefined)?.actions ?? []
  const action = { ...call, n: (prev.at(-1)?.n ?? 0) + 1, client: target.client }
  awareness.setLocalState({ ...state, [field]: { actions: [...prev.slice(-7), action] } })
  return true
}

/** 界面执行撤销 / 重做后回传的结果（前端见 apps/web/src/canvas/agentUi.ts） */
export interface UndoReply {
  done: number
  can_undo: boolean
  can_redo: boolean
}

/** 等前端回传的最长时间 */
const REPLY_TIMEOUT_MS = 5000

/**
 * 请用户当前打开这块画布的标签页执行撤销 / 重做，并等它回传实际结果。
 * 动作经房间 awareness 推出（与 ui_focus 等同一通道，带 client 指定唯一执行者，
 * 多个标签页同时打开时只有最近活跃的那个执行，避免各自的撤销栈重复回退）；
 * 前端把结果写回自己的 awareness 状态（agentUiReply）。没有标签页时返回 undefined。
 */
export function requestUndo(
  rooms: Rooms,
  canvasId: string,
  call: { steps: number; redo: boolean },
  timeoutMs = REPLY_TIMEOUT_MS,
): Promise<UndoReply | undefined> {
  const awareness = rooms.get(canvasId).awareness
  const target = activeView(rooms, canvasId)
  if (!target) return Promise.resolve(undefined)
  const client = target.client
  const state = awareness.getLocalState() ?? {}
  const prev = ((state.agentUi as { actions?: Array<{ n: number }> } | undefined)?.actions ??
    []) as Array<{ n: number }>
  const n = (prev.at(-1)?.n ?? 0) + 1
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      awareness.off('change', onChange)
      fn()
    }
    const onChange = () => {
      const reply = (
        awareness.getStates().get(client) as
          | { agentUiReply?: UndoReply & { n: number } }
          | undefined
      )?.agentUiReply
      if (reply?.n === n)
        finish(() =>
          resolve({ done: reply.done, can_undo: reply.can_undo, can_redo: reply.can_redo }),
        )
    }
    const timer = setTimeout(
      () => finish(() => reject(new CapabilityError('用户界面没有响应撤销请求，操作可能没有执行'))),
      timeoutMs,
    )
    awareness.on('change', onChange)
    awareness.setLocalState({
      ...state,
      agentUi: { actions: [...prev.slice(-7), { n, action: 'undo', client, ...call }] },
    })
  })
}
