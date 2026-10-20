import {
  type CanvasElement,
  elementPorts,
  type Port,
  type PortType,
  portsCompatible,
  type Rect,
} from '@plein/doc'
import { theme } from './theme'
import type { Scene } from './scene'

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

/** 绘制和命中共用端口中心的遮挡判断，不能从旁边点中已隐藏的连接点。 */
export function portUncovered(scene: Scene, ref: Pick<PortRef, 'elementId' | 'x' | 'y'>) {
  const front = scene.hitTest(ref.x, ref.y, (id) => scene.get(id)?.kind !== 'frame')
  return (
    !front || front === ref.elementId || scene.drawOrder(front) < scene.drawOrder(ref.elementId)
  )
}

/** 端口按类型着色（随主题变化） */
export const portColor = (type: PortType) => theme.ports[type]

export function portList(el: CanvasElement, side: PortSide) {
  const ports = elementPorts(el)
  return (side === 'in' ? ports?.inputs : ports?.outputs) ?? []
}

/**
 * 每侧只有一个连接点：输入在左边中点、输出在右边中点。
 * 一侧的多个端口都落在这一点上，连线时按数据类型自动接到对应端口。
 */
export function portPosition(_el: CanvasElement, rect: Rect, side: PortSide, _index?: number) {
  return { x: side === 'in' ? rect.x : rect.x + rect.w, y: rect.y + rect.h / 2 }
}

export function eachPort(el: CanvasElement, rect: Rect, fn: (ref: PortRef) => void) {
  for (const side of ['in', 'out'] as const) {
    for (const port of portList(el, side))
      fn({ elementId: el.id, port, side, ...portPosition(el, rect, side) })
  }
}

/** 一侧的连接点：同侧所有端口共用一个位置，画的时候只画一次 */
export function eachHandle(
  el: CanvasElement,
  rect: Rect,
  fn: (side: PortSide, ports: Port[], at: { x: number; y: number }) => void,
) {
  for (const side of ['in', 'out'] as const) {
    const ports = portList(el, side)
    if (ports.length) fn(side, ports, portPosition(el, rect, side))
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
  return { elementId: el.id, port: list[i]!, side, ...portPosition(el, rect, side) }
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

/** 同一个连接点上的全部端口（PortRef 只是其中之一） */
export function sidePorts(el: CanvasElement, ref: PortRef): PortRef[] {
  return portList(el, ref.side).map((port) => ({ ...ref, port }))
}

/** 输出 -> 输入，且类型兼容（any 通配） */
export function canConnect(a: PortRef, b: PortRef) {
  if (a.elementId === b.elementId || a.side === b.side) return false
  return portsCompatible(a.port.type, b.port.type)
}
