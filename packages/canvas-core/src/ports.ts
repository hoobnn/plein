import { type CanvasElement, elementPorts, type Port, type PortType, type Rect } from '@plein/doc'
import { theme } from './theme'

/** 端口半径（世界坐标） */
export const PORT_RADIUS = 6

export type PortSide = 'in' | 'out'

export interface PortRef {
  elementId: string
  port: Port
  side: PortSide
  x: number
  y: number
}

/** 端口按类型着色（随主题变化） */
export const portColor = (type: PortType) => theme.ports[type]

function portList(el: CanvasElement, side: PortSide) {
  const ports = elementPorts(el)
  return (side === 'in' ? ports?.inputs : ports?.outputs) ?? []
}

/** 输入端口沿左边、输出端口沿右边均匀分布；rect 为世界坐标 */
export function portPosition(el: CanvasElement, rect: Rect, side: PortSide, index: number) {
  const n = portList(el, side).length
  return {
    x: side === 'in' ? rect.x : rect.x + rect.w,
    y: rect.y + (rect.h * (index + 1)) / (n + 1),
  }
}

export function eachPort(el: CanvasElement, rect: Rect, fn: (ref: PortRef) => void) {
  for (const side of ['in', 'out'] as const) {
    portList(el, side).forEach((port, i) => {
      fn({ elementId: el.id, port, side, ...portPosition(el, rect, side, i) })
    })
  }
}

export function findPort(
  el: CanvasElement,
  rect: Rect,
  portId: string,
  side: PortSide,
): PortRef | null {
  const list = portList(el, side)
  const i = list.findIndex((p) => p.id === portId)
  if (i < 0) return null
  return { elementId: el.id, port: list[i]!, side, ...portPosition(el, rect, side, i) }
}

/** 离 (wx, wy) 最近、且在 radius 内的端口 */
export function hitPort(
  candidates: Iterable<[CanvasElement, Rect]>,
  wx: number,
  wy: number,
  radius: number,
  filter?: (ref: PortRef) => boolean,
): PortRef | null {
  let best: PortRef | null = null
  let bestD = radius * radius
  for (const [el, rect] of candidates) {
    eachPort(el, rect, (ref) => {
      const d = (ref.x - wx) ** 2 + (ref.y - wy) ** 2
      if (d <= bestD && (!filter || filter(ref))) {
        best = ref
        bestD = d
      }
    })
  }
  return best
}

/** 输出 -> 输入，且类型兼容（any 通配） */
export function canConnect(a: PortRef, b: PortRef) {
  if (a.elementId === b.elementId || a.side === b.side) return false
  return a.port.type === 'any' || b.port.type === 'any' || a.port.type === b.port.type
}
