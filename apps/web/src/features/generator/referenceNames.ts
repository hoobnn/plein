import { type PleinDoc, setParam } from '@plein/doc'
import { boundReferenceTokens, referenceBindings, type ReferenceIdentity } from '@plein/plugin-sdk'

/** 名称重复时按元素 id 消歧，顺序不随连线或结果变化。 */
export function referenceName(doc: PleinDoc, item: ReferenceIdentity) {
  const source = item.source && doc.get(item.source)
  const name = (source && source.name?.trim()) || '参考素材'
  const peers = [...doc.elements()]
    .filter((el) => (el.name?.trim() || '参考素材') === name)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return peers.length > 1 ? `${name}#${peers.findIndex((el) => el.id === item.source) + 1}` : name
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
) {
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
    if (bindings[token.name]?.source !== oldSource) continue
    const name = bindReferenceName(doc, nodeId, item)
    next = next.slice(0, token.start) + `@${name}` + next.slice(token.end)
  }
  if (next !== prompt) setParam(doc, nodeId, 'prompt', next)
}
