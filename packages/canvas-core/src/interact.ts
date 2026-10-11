import { connectPorts, removeEdge, type CanvasElement, type PleinDoc } from '@plein/doc'
import type { Camera } from './camera'
import type { EdgeLayer } from './edges'
import { PORT_RADIUS, canConnect, findPort, hitPort, type PortRef } from './ports'

/** 端口命中范围：屏幕上至少 10px，便于缩小后也能点中 */
const HIT_PX = 10

type Gesture =
  | { kind: 'connect'; from: PortRef }
  | { kind: 'move'; id: string; ox: number; oy: number; sx: number; sy: number }

/**
 * 左键交互（空格/中键留给相机平移）：
 * - 从端口拖出 = 连线；松手落在兼容端口上写入一条边
 * - 从已连接的输入端口拖出 = 拾起这条边，丢到空白处即删除
 * - 拖节点本体 = 移动节点
 */
export function attachInteractions(
  el: HTMLElement,
  camera: Camera,
  doc: PleinDoc,
  layer: EdgeLayer,
) {
  let spaceDown = false
  let gesture: Gesture | null = null

  const toWorld = (e: PointerEvent) => {
    const rect = el.getBoundingClientRect()
    return camera.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  }
  const radius = () => Math.max(PORT_RADIUS * 1.5, HIT_PX / camera.zoom)

  const hitElement = (x: number, y: number) => {
    let hit: CanvasElement | null = null
    for (const n of doc.elements.values()) {
      if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) hit = n
    }
    return hit
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || spaceDown) return
    const w = toWorld(e)
    const port = hitPort(doc.elements.values(), w.x, w.y, radius())
    if (port) {
      let from = port
      if (port.side === 'in') {
        // 输入端口已有连线：拾起它，改从上游输出端口继续拖
        const existing = [...doc.edges.values()].find(
          (edge) => edge.to[0] === port.elementId && edge.to[1] === port.port.id,
        )
        const src = existing && doc.elements.get(existing.from[0])
        const srcPort = src && findPort(src, existing.from[1], 'out')
        if (existing && srcPort) {
          removeEdge(doc, existing.id)
          from = srcPort
        }
      }
      gesture = { kind: 'connect', from }
      layer.setPreview({ from, x: w.x, y: w.y, target: null })
    } else {
      const node = hitElement(w.x, w.y)
      if (!node) return
      doc.undo.stopCapturing()
      gesture = { kind: 'move', id: node.id, ox: node.x, oy: node.y, sx: w.x, sy: w.y }
    }
    el.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    const w = toWorld(e)
    if (!gesture) {
      if (spaceDown) return
      const port = hitPort(doc.elements.values(), w.x, w.y, radius())
      layer.setHover(port)
      el.style.cursor = port ? 'crosshair' : ''
      return
    }
    if (gesture.kind === 'connect') {
      const { from } = gesture
      const target = hitPort(doc.elements.values(), w.x, w.y, radius(), (p) => canConnect(from, p))
      layer.setPreview({ from, x: w.x, y: w.y, target })
    } else {
      const node = doc.elements.get(gesture.id)
      if (!node) return
      doc.elements.set(node.id, {
        ...node,
        x: gesture.ox + w.x - gesture.sx,
        y: gesture.oy + w.y - gesture.sy,
      })
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!gesture) return
    const w = toWorld(e)
    if (gesture.kind === 'connect') {
      const { from } = gesture
      const target = hitPort(doc.elements.values(), w.x, w.y, radius(), (p) => canConnect(from, p))
      if (target) {
        const [out, inp] = from.side === 'out' ? [from, target] : [target, from]
        connectPorts(doc, [out.elementId, out.port.id], [inp.elementId, inp.port.id])
      }
      layer.setPreview(null)
    }
    gesture = null
    el.releasePointerCapture(e.pointerId)
    layer.setHover(hitPort(doc.elements.values(), w.x, w.y, radius()))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space') spaceDown = true
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') spaceDown = false
  }

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  return () => {
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', onPointerUp)
    el.removeEventListener('pointercancel', onPointerUp)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
  }
}
