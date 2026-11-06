import type { Engine } from '@plein/canvas-core'
import type { WebsocketProvider } from 'y-websocket'

/** 服务端（外部 MCP）经 awareness 推来的界面动作；n 单调递增，每个客户端只执行比自己见过的更新的 */
type UiAction =
  | { n: number; action: 'focus' | 'select'; ids: string[] }
  | { n: number; action: 'viewport'; x: number; y: number; zoom: number }

/**
 * 执行外部 AI 应用经 MCP 发来的界面动作（ui_focus / ui_select / ui_set_viewport）。
 * 只处理挂载之后发出的动作，历史动作不重放。
 */
export function watchAgentUi(awareness: WebsocketProvider['awareness'], engine: Engine) {
  const seen = new Map<number, number>()
  const actionsOf = (state: unknown): UiAction[] => {
    const list = (state as { agentUi?: { actions?: unknown } } | undefined)?.agentUi?.actions
    return Array.isArray(list) ? (list as UiAction[]) : []
  }
  const scan = (run: boolean) => {
    for (const [client, state] of awareness.getStates()) {
      if (client === awareness.clientID) continue
      let last = seen.get(client) ?? 0
      for (const a of actionsOf(state)) {
        if (a.n <= last) continue
        last = a.n
        if (!run) continue
        if (a.action === 'select') engine.selection.set(a.ids)
        else if (a.action === 'viewport') engine.camera.lookAt(a.x, a.y, a.zoom)
        else engine.flyTo(a.ids)
      }
      seen.set(client, last)
    }
  }
  scan(false)
  const onChange = () => scan(true)
  awareness.on('change', onChange)
  return () => awareness.off('change', onChange)
}
