import {
  type CanvasElement,
  type NewElement,
  nodeSize,
  type PleinDoc,
  parseAspect,
  type Port,
} from '@plein/doc'
import { mentionName } from '@plein/nodes'
import type { NodeDescriptor } from '@plein/plugin-sdk'

/** 按节点类型给出新建卡片的骨架（端口、默认参数、默认大小）；目录里没有时返回 undefined */
export type NodeFactory = (type: string) => Omit<NewElement, 'x' | 'y'> | undefined

/** 节点声明 → 卡片骨架：端口和默认参数一律来自声明 */
export function nodeElementOf(
  desc: NodeDescriptor,
  params: Record<string, unknown> = desc.defaults,
): Omit<NewElement, 'x' | 'y'> {
  const port = (p: NodeDescriptor['inputs'][number]): Port => ({
    id: p.id,
    label: p.label,
    type: p.type,
    ...(p.multiple ? { multiple: true } : {}),
    ...(p.required ? { required: true } : {}),
  })
  return {
    kind: 'node',
    nodeType: desc.type,
    nodeVersion: desc.version,
    name: desc.title,
    params,
    ports: { inputs: desc.inputs.map(port), outputs: desc.outputs.map(port) },
    ...nodeSize(desc.outputs[0]?.type, parseAspect(params.aspectRatio)),
  }
}

/** 按名字取可 @ 引用的元素；重名的全部返回，调用方要自己判断指不指得准 */
export function mentionElements(doc: PleinDoc): Map<string, CanvasElement[]> {
  const out = new Map<string, CanvasElement[]>()
  for (const el of doc.elements()) {
    const name = mentionName(el)
    if (!name) continue
    const list = out.get(name)
    if (list) list.push(el)
    else out.set(name, [el])
  }
  return out
}
