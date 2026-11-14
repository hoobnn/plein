import { referenceAlias } from '@plein/capabilities'
import { elementPorts, type PleinDoc, setParam, setParams } from '@plein/doc'
import { boundReferenceTokens, referenceBindings, type ReferenceIdentity } from '@plein/plugin-sdk'

/**
 * 名称重复时按元素 id 消歧，非默认输出口再加「·端口名」，
 * 顺序不随连线、结果或插入顺序变化。
 */
export function referenceName(doc: PleinDoc, item: ReferenceIdentity) {
  return referenceAlias(doc, item) ?? '参考素材'
}

export function bindReferenceName(doc: PleinDoc, nodeId: string, item: ReferenceIdentity) {
  const name = referenceName(doc, item)
  setParam(
    doc,
    nodeId,
    `referenceNameBinding:${encodeURIComponent(name)}:${item.source ?? item.assetId}`,
    {
      type: item.type,
      assetId: item.assetId,
      ...(item.source ? { source: item.source } : {}),
      ...(item.sourcePort ? { sourcePort: item.sourcePort } : {}),
    },
  )
  return name
}

/** 旧编号改为当前来源名称；已被移除的旧素材不再留下失效编号。 */
export function migrateReferenceNames(
  doc: PleinDoc,
  nodeId: string,
  current: ReferenceIdentity[],
  removeMissing = true,
) {
  const el = doc.get(nodeId)
  if (!el) return
  const bindings = referenceBindings(el.params)
  const prompt = String(el.params?.prompt ?? '')
  let next = prompt
  for (const token of boundReferenceTokens(prompt, el.params).reverse()) {
    if (!/^(image|video|audio)[1-9]\d*$/.test(token.name)) continue
    if (
      Object.keys(el.params ?? {}).some((key) =>
        key.startsWith(`referenceNameBinding:${encodeURIComponent(token.name)}:`),
      )
    )
      continue
    const binding = bindings[token.name]
    if (!binding || !binding.assetId) continue
    const item = current.find(
      (item) =>
        item.type === binding.type &&
        (binding.source ? item.source === binding.source : item.assetId === binding.assetId),
    )
    if (!item && !removeMissing) continue
    const replacement = item ? `@${bindReferenceName(doc, nodeId, item)}` : ''
    next = next.slice(0, token.start) + replacement + next.slice(token.end)
  }
  if (next !== prompt) setParam(doc, nodeId, 'prompt', next)
}

/** 用户明确替换槽位时，让正文引用跟着替换；与连线一起撤销。 */
export function replaceReferenceName(
  doc: PleinDoc,
  nodeId: string,
  oldSource: string,
  item: ReferenceIdentity,
  /** 被替换的那条连线读的是哪个输出口；旧绑定没记录端口时按媒体类型判断。 */
  oldSourcePort?: string,
) {
  const oldType = outputKind(doc, oldSource, oldSourcePort)
  const el = doc.get(nodeId)
  if (!el) return
  const bindings = referenceBindings(el.params)
  const prompt = String(el.params?.prompt ?? '')
  const tokens = boundReferenceTokens(prompt, el.params)
  const old = doc.get(oldSource)
  // 兼容尚未建立名称绑定的普通图片 @ 引用。
  if (old?.name) {
    const oldName = referenceName(doc, {
      type: item.type,
      source: oldSource,
      assetId: old.assetId ?? '',
    })
    const plain = boundReferenceTokens(prompt, {
      referenceBindings: {
        [oldName]: { type: item.type, assetId: old.assetId ?? '', source: oldSource },
      },
    })
    for (const token of plain) if (!tokens.some((t) => t.start === token.start)) tokens.push(token)
    bindings[oldName] ??= { type: item.type, assetId: old.assetId ?? '', source: oldSource }
  }
  let next = prompt
  for (const token of tokens.sort((a, b) => b.start - a.start)) {
    if (!bindingIsOutput(bindings[token.name], oldSource, oldSourcePort, oldType)) continue
    const name = bindReferenceName(doc, nodeId, item)
    next = next.slice(0, token.start) + `@${name}` + next.slice(token.end)
  }
  if (next !== prompt) setParam(doc, nodeId, 'prompt', next)
  // 换掉来源后，旧来源这一路的绑定就是残留数据：一起清掉，同源其他输出口保留。
  clearSourceBindings(doc, nodeId, oldSource, oldSourcePort)
}

/** 清掉指向某个来源（或它某个输出口）的绑定（名称绑定、旧编号绑定都算）。 */
export function clearSourceBindings(
  doc: PleinDoc,
  nodeId: string,
  source: string,
  sourcePort?: string,
) {
  const el = doc.get(nodeId)
  if (!el?.params) return
  const oldType = outputKind(doc, source, sourcePort)
  const matches = (key: string, value: unknown) => {
    if (bindingSource(key, value) !== source) return false
    return bindingIsOutput(bindingOf(value), source, sourcePort, oldType)
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(el.params)) {
    if (key === 'referenceBindings') continue
    if (matches(key, value)) patch[key] = undefined
  }
  const nested = el.params.referenceBindings
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const entries = Object.entries(nested as Record<string, unknown>)
    const kept = entries.filter(([key, value]) => !matches(key, value))
    if (kept.length !== entries.length) patch.referenceBindings = Object.fromEntries(kept)
  }
  if (Object.keys(patch).length) setParams(doc, nodeId, patch)
}

/** 一条绑定是不是某个输出口：新绑定看 sourcePort，旧绑定按媒体类型区分同源不同口。 */
function bindingIsOutput(
  binding: ReferenceIdentity | undefined,
  source: string,
  sourcePort: string | undefined,
  oldType: ReferenceIdentity['type'] | undefined,
) {
  if (!binding || binding.source !== source) return false
  if (!sourcePort) return true
  if (binding.sourcePort) return binding.sourcePort === sourcePort
  return !oldType || binding.type === oldType
}

/** 输出口的媒体类型；来源或端口不存在时返回 undefined。 */
function outputKind(doc: PleinDoc, source: string, sourcePort?: string) {
  if (!sourcePort) return undefined
  const el = doc.get(source)
  const port = el ? elementPorts(el)?.outputs.find((item) => item.id === sourcePort) : undefined
  const type = port?.type
  return type === 'image' || type === 'video' || type === 'audio' ? type : undefined
}

function bindingOf(value: unknown): ReferenceIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Partial<ReferenceIdentity>
  if (item.type !== 'image' && item.type !== 'video' && item.type !== 'audio') return undefined
  return {
    type: item.type,
    assetId: typeof item.assetId === 'string' ? item.assetId : '',
    ...(typeof item.source === 'string' ? { source: item.source } : {}),
    ...(typeof item.sourcePort === 'string' ? { sourcePort: item.sourcePort } : {}),
  }
}

/** 一条绑定指向哪个来源元素；旧编号绑定从键名里取。 */
function bindingSource(key: string, value: unknown): string | undefined {
  const named = key.startsWith('referenceNameBinding:')
  const legacy = key.startsWith('referenceBinding:')
  const numbered = /^(image|video|audio)[1-9]\d*(?::|$)/.test(key)
  if (!named && !legacy && !numbered) return undefined
  if (value && typeof value === 'object' && 'source' in value && typeof value.source === 'string')
    return value.source
  if (named) {
    const body = key.slice('referenceNameBinding:'.length)
    return body.slice(body.lastIndexOf(':') + 1) || undefined
  }
  if (legacy) return key.slice('referenceBinding:'.length).split(':')[1] || undefined
  return undefined
}
