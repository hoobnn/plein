import {
  connect,
  createElement,
  elementPorts,
  type NewElement,
  type PleinDoc,
  type Port,
  portsCompatible,
  spotAfterContent,
  spotRightOf,
} from '@plein/doc'
import { CapabilityError } from './define'

/** 新元素的放置参数：参照元素右侧、指定坐标或画布内容右侧；可放进 Frame */
export interface Placement {
  near?: string
  x?: number
  y?: number
  parent_id?: string
}

export function need(doc: PleinDoc, id: string) {
  const el = doc.get(id)
  if (!el) throw new CapabilityError(`元素 ${id} 不存在，先用 get_canvas 查看当前画布`)
  return el
}

/** 解析放置位置并建元素，返回新元素 id */
export function placeNew(
  doc: PleinDoc,
  a: Placement,
  input: Omit<NewElement, 'x' | 'y'> & { w: number; h: number },
  view?: { x: number; y: number; w: number; h: number } | null,
): string {
  if (a.near) need(doc, a.near)
  const world =
    a.x !== undefined && a.y !== undefined
      ? { x: a.x, y: a.y }
      : a.near
        ? spotRightOf(doc, a.near, input.w, input.h)
        : view && !doc.children(null).length
          ? { x: view.x + (view.w - input.w) / 2, y: view.y + (view.h - input.h) / 2 }
          : spotAfterContent(doc, input.w, input.h)
  const parentId = a.parent_id ?? (a.near ? (doc.get(a.near)?.parentId ?? null) : null)
  if (parentId && doc.get(parentId)?.kind !== 'frame')
    throw new CapabilityError(`${parentId} 不是 Frame`)
  const origin = parentId ? (doc.worldRect(parentId) ?? { x: 0, y: 0 }) : { x: 0, y: 0 }
  return createElement(doc, {
    ...input,
    parentId,
    x: Math.round(world.x - origin.x),
    y: Math.round(world.y - origin.y),
  } as NewElement)
}

/** 按端口类型连线；端口不填时自动匹配第一对兼容的端口。返回给人看的一行描述 */
export function link(
  doc: PleinDoc,
  fromId: string,
  fromPort: string | undefined,
  toId: string,
  toPort: string | undefined,
): string {
  const from = elementPorts(need(doc, fromId))
  const to = elementPorts(need(doc, toId))
  if (!from?.outputs.length)
    throw new CapabilityError(`${fromId} 没有输出端口（素材元素需要有内容）`)
  if (!to?.inputs.length) throw new CapabilityError(`${toId} 没有输入端口`)
  const outs = fromPort ? from.outputs.filter((p) => p.id === fromPort) : from.outputs
  if (!outs.length) throw new CapabilityError(`${fromId} 没有输出端口 ${fromPort}`)
  let pair: [Port, Port] | undefined
  for (const o of outs) {
    const ins = toPort ? to.inputs.filter((p) => p.id === toPort) : to.inputs
    const i = ins.find((p) => portsCompatible(o.type, p.type))
    if (i) {
      pair = [o, i]
      break
    }
  }
  if (!pair) {
    const list = to.inputs.map((p) => `${p.id}(${p.type})`).join('、')
    throw new CapabilityError(`端口类型对不上：${toId} 的输入端口有 ${list}`)
  }
  const edge = connect(doc, [fromId, pair[0].id], [toId, pair[1].id])
  return edge
    ? `${edge.id}: ${fromId}.${pair[0].id} → ${toId}.${pair[1].id}`
    : `已连接：${fromId}.${pair[0].id} → ${toId}.${pair[1].id}`
}
