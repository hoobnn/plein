import { CapabilityError } from '@plein/capabilities'
import type { Rooms } from '../sync/rooms'
import type { ViewState } from './tool-registry'

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
  let target: { client: number; at: number } | undefined
  for (const [client, st] of awareness.getStates()) {
    const v = (st as { view?: ViewState }).view
    if (v && Array.isArray(v.selection) && v.viewport && (!target || v.at > target.at))
      target = { client, at: v.at }
  }
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
