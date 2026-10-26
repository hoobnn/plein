import { StageScene } from '@plein/nodes'
import type { WebsocketProvider } from 'y-websocket'
import { api } from '../api/client'

/** 请求只包含渲染输入；不执行模型、脚本或画布写入。 */
export function watchAgentRender(awareness: WebsocketProvider['awareness']) {
  let disposed = false
  const pending = new Set<string>()
  const check = () => {
    const active = new Set(
      [...awareness.getStates().values()].flatMap((s) => Object.keys(s.canvasRenderRequests ?? {})),
    )
    for (const id of pending) if (!active.has(id)) pending.delete(id)
    for (const state of awareness.getStates().values()) {
      const requests = state.canvasRenderRequests as
        | Record<string, { client: number; scene: unknown }>
        | undefined
      for (const [id, req] of Object.entries(requests ?? {})) {
        if (req.client !== awareness.clientID || pending.has(id)) continue
        pending.add(id)
        void (async () => {
          const host = document.createElement('div')
          host.style.cssText =
            'position:fixed;left:-10000px;top:0;width:800px;height:600px;pointer-events:none'
          let view: import('../features/stage/view').StageView | undefined
          let result: { assetId: string } | { error: string }
          try {
            const scene = StageScene.parse(req.scene)
            document.body.append(host)
            const { StageView } = await import('../features/stage/view')
            if (disposed) return
            view = new StageView(host, {
              onSelect() {},
              onMove() {},
              onCamera() {},
              readOnly: () => true,
            })
            view.setScene(scene)
            const blob = await view.snapshot()
            if (
              disposed ||
              ![...awareness.getStates().values()].some((s) => s.canvasRenderRequests?.[id])
            )
              return
            const asset = await api.upload(new File([blob], '构图参考.png', { type: 'image/png' }))
            result = { assetId: asset.id }
          } catch (error) {
            result = { error: error instanceof Error ? error.message : '构图截图失败' }
          } finally {
            view?.dispose()
            host.remove()
          }
          if (disposed) return
          const prev = Object.entries(awareness.getLocalState()?.canvasRenderResults ?? {}).slice(
            -7,
          )
          awareness.setLocalStateField('canvasRenderResults', {
            ...Object.fromEntries(prev),
            [id]: result,
          })
        })()
      }
    }
  }
  awareness.setLocalStateField('canvasRenderer', 1)
  awareness.on('change', check)
  check()
  return () => {
    disposed = true
    awareness.off('change', check)
    awareness.setLocalStateField('canvasRenderer', undefined)
  }
}
