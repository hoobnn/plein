import { nodeElementOf } from '@plein/capabilities'
import { setParam, setText, type CanvasElement, type NewElement, type PleinDoc } from '@plein/doc'
import { characterNode, imageNode, sceneNode, videoNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { SyncFields } from './provider'

// Audio prompts may represent speech, music or effects. Preserve their text until that distinction is known.
const native = [
  { kind: 'role', field: 'description', node: characterNode },
  { kind: 'scene', field: 'description', node: sceneNode },
  { kind: 'image', field: 'prompt', node: imageNode },
  { kind: 'video', field: 'prompt', node: videoNode },
].map(({ kind, field, node }) => ({ kind, field, desc: describeNode(node, 'plein/core') }))

export function localCard(el: CanvasElement) {
  if (el.kind === 'markdown') return { kind: 'text', text: el.text ?? '' }
  if (el.kind !== 'node') return
  const def = native.find((n) => n.desc.type === el.nodeType)
  const field = el.nodeType === 'plein/text' ? 'text' : def?.field
  if (!field) return
  const text = el.params?.[field]
  if (text !== undefined && typeof text !== 'string') return
  return { kind: def?.kind ?? 'text', field, text: text ?? '' }
}

export function importCard(kind: string, fields: SyncFields): Omit<NewElement, 'x' | 'y'> {
  const rule = native.find((n) => n.kind === kind)
  if (!rule) return { kind: 'markdown', name: fields.title, text: fields.text, w: 384, h: 180 }
  return {
    ...nodeElementOf(rule.desc, { ...rule.desc.defaults, [rule.field]: fields.text }),
    name: fields.title,
  }
}

export function writeCardText(doc: PleinDoc, el: CanvasElement, text: string) {
  const card = localCard(el)
  if (!card) throw new Error('Plein 节点类型已变化，请重新核对')
  if (card.field) setParam(doc, el.id, card.field, text)
  else setText(doc, el.id, text)
}
