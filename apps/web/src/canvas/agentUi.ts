import type { Engine } from '@plein/canvas-core'
import type { WebsocketProvider } from 'y-websocket'

/** 服务端（外部 MCP）经 awareness 推来的界面动作；n 单调递增，每个客户端只执行比自己见过的更新的 */
type UiAction = { client?: number } & (
  | { n: number; action: 'focus' | 'select'; ids: string[] }
  | { n: number; action: 'viewport'; x: number; y: number; zoom: number }
  | { n: number; action: 'open_canvas'; id: string }
  /** 撤销 / 重做：client 指定唯一执行的标签页，结果经 agentUiReply 回传 */
  | { n: number; action: 'undo'; client: number; steps: number; redo: boolean }
)

/** 与用户按 ⌘Z / ⇧⌘Z 同一撤销栈：连续执行 steps 步，把实际步数和剩余状态写回 awareness */
function replyUndo(
  awareness: WebsocketProvider['awareness'],
  engine: Engine,
  a: Extract<UiAction, { action: 'undo' }>,
) {
  const steps = Math.min(Math.max(Math.trunc(a.steps) || 1, 1), 20)
  let done = 0
  while (done < steps) {
    const { canUndo, canRedo } = engine.state
    if (!(a.redo ? canRedo : canUndo)) break
    if (a.redo) engine.redo()
    else engine.undo()
    done++
  }
  const { canUndo, canRedo } = engine.state
  awareness.setLocalStateField('agentUiReply', {
    n: a.n,
    done,
    can_undo: canUndo,
    can_redo: canRedo,
  })
}

/**
 * 执行外部 AI 应用经 MCP 发来的界面动作（定位、选择、切换画布与撤销）。
 * 只处理挂载之后发出的动作，历史动作不重放。
 */
export function watchAgentUi(
  awareness: WebsocketProvider['awareness'],
  engine: Engine,
  openCanvas: (id: string) => void,
) {
  // Legacy server messages and the targeted v2 stream have independent sequence numbers.
  const seen = { agentUi: new Map<number, number>(), agentUiV2: new Map<number, number>() }
  const scan = (run: boolean) => {
    for (const [client, state] of awareness.getStates()) {
      if (client === awareness.clientID) continue
      for (const field of ['agentUi', 'agentUiV2'] as const) {
        const actions: UiAction[] | undefined = state[field]?.actions
        if (!Array.isArray(actions)) continue
        for (const a of actions) {
          if (a.n <= (seen[field].get(client) ?? 0)) continue
          // A reply changes awareness synchronously and may re-enter this handler.
          seen[field].set(client, a.n)
          if (!run || (a.client !== undefined && a.client !== awareness.clientID)) continue
          if (a.action === 'undo') replyUndo(awareness, engine, a)
          else if (a.action === 'open_canvas') openCanvas(a.id)
          else if (a.action === 'select') engine.selection.set(a.ids)
          else if (a.action === 'viewport') engine.camera.lookAt(a.x, a.y, a.zoom)
          else if (a.action === 'focus' && !a.ids.length) engine.zoomToFit()
          else if (a.action === 'focus') engine.flyTo(a.ids)
        }
      }
    }
  }
  scan(false)
  const onChange = () => scan(true)
  awareness.on('change', onChange)
  return () => awareness.off('change', onChange)
}
