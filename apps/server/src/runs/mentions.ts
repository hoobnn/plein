import type { CanvasElement, PleinDoc } from '@plein/doc'
import { ASSET_NODE_TYPES, findMentions } from '@plein/nodes'
import type { NodeDefinition, PortValue } from '@plein/plugin-sdk'

type Inputs = Record<string, PortValue[]>

/** 会把被引用资产的设定附在提示词后面的能力；配音等不附（台词里不该混进设定） */
const DESCRIBE: ReadonlySet<string> = new Set(['text.chat', 'image.generate', 'video.generate'])

/** 画布上可被 @ 引用的东西：资产卡（角色、场景）和有名字的图片元素，重名时先出现的生效 */
export function mentionTargets(doc: PleinDoc): Map<string, CanvasElement> {
  const out = new Map<string, CanvasElement>()
  for (const el of doc.elements()) {
    const name = el.name?.trim()
    if (!name || out.has(name)) continue
    const asset = el.kind === 'node' && el.nodeType && ASSET_NODE_TYPES.has(el.nodeType)
    if (asset || (el.kind === 'image' && el.assetId)) out.set(name, el)
  }
  return out
}

/**
 * 运行前处理提示词里的 @ 引用：
 * - 文本里的 `@林夏` 换成 `林夏`；对话、图片、视频节点在主提示词后附上被引用者的设定；
 * - 被引用者的参考图并入节点的 `references` 输入（去重）；
 * - 配音节点没选音色、且只引用了一个有音色的角色时，用它的音色。
 * 返回新的参数与输入，不改文档。
 */
export async function applyMentions(
  doc: PleinDoc,
  el: CanvasElement,
  def: NodeDefinition,
  inputs: Inputs,
  collect: (id: string) => Promise<Inputs>,
): Promise<{ params: Record<string, unknown>; inputs: Inputs }> {
  const params = { ...el.params }
  const targets = mentionTargets(doc)
  const hit = new Map<string, CanvasElement>()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value.includes('@')) continue
    const found = findMentions(value, targets).filter((m) => m.target.id !== el.id)
    if (found.length === 0) continue
    let text = ''
    let last = 0
    for (const m of found) {
      text += `${value.slice(last, m.start)}${m.name}`
      last = m.end
      hit.set(m.name, m.target)
    }
    params[key] = text + value.slice(last)
  }
  if (hit.size === 0) return { params, inputs }

  const refs: PortValue[] = []
  const notes: string[] = []
  const voices: string[] = []
  for (const [name, target] of hit) {
    if (target.kind === 'image' && target.assetId) {
      refs.push({ type: 'image', assetId: target.assetId, kind: 'image' })
      continue
    }
    const description = String(target.params?.description ?? '').trim()
    if (description) notes.push(`${name}：${description}`)
    const voice = String(target.params?.voice ?? '').trim()
    if (voice) voices.push(voice)
    const own = await collect(target.id)
    refs.push(...(own.references ?? []).filter((v) => v.type === 'image'))
  }

  const prompt = ['prompt', 'text'].find((k) => typeof params[k] === 'string')
  if (prompt && notes.length && def.capability && DESCRIBE.has(def.capability))
    params[prompt] = `${params[prompt]}\n\n设定：\n${notes.join('\n')}`

  if (def.capability === 'audio.speech' && !params.voice && voices.length === 1)
    params.voice = voices[0]

  const port = def.inputs.find((p) => p.id === 'references' && p.type === 'image')
  if (port && refs.length) {
    const seen = new Set<string>()
    const merged = [...(inputs.references ?? []), ...refs].filter((v) => {
      const id = 'assetId' in v ? v.assetId : ''
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    return { params, inputs: { ...inputs, references: merged } }
  }
  return { params, inputs }
}
