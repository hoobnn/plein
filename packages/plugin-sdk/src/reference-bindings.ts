import { videoReferenceTokens } from './video-input'

export interface ReferenceIdentity {
  type: 'image' | 'video' | 'audio'
  assetId: string
  source?: string
}
export type ReferenceBindings = Record<string, ReferenceIdentity>

/** 编号是持久别名；身份同时固定来源和资产，替换上游结果不会静默换图。 */
export function referenceBindings(value: unknown): ReferenceBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const nested = record.referenceBindings
  const entries = Object.entries(
    nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {},
  )
  for (const [key, item] of Object.entries(record)) {
    if (key.startsWith('referenceBinding:'))
      entries.push([key.slice('referenceBinding:'.length), item])
    else if (/^(image|video|audio)[1-9]\d*(?::|$)/.test(key)) entries.push([key, item])
  }
  const result: ReferenceBindings = {}
  for (const [entry, item] of entries) {
    const key = entry.split(':')[0]!
    if (!/^(image|video|audio)[1-9]\d*$/.test(key) || !item || typeof item !== 'object') continue
    const identity = item as ReferenceIdentity
    if (
      !['image', 'video', 'audio'].includes(identity.type) ||
      typeof identity.assetId !== 'string' ||
      (identity.source !== undefined && typeof identity.source !== 'string') ||
      !key.startsWith(identity.type)
    )
      continue
    // 协作者同时分配同一别名时保留两条提案并使别名失效，不能用最后写入者覆盖引用身份。
    result[key] =
      result[key] && !sameReference(result[key]!, identity)
        ? { type: identity.type, assetId: '', source: 'conflict' }
        : identity
  }
  return result
}

export function sameReference(a: ReferenceIdentity, b: ReferenceIdentity) {
  return a.type === b.type && a.assetId === b.assetId && a.source === b.source
}

export function referenceAliases<T extends ReferenceIdentity>(items: T[], value: unknown) {
  const bindings = referenceBindings(value)
  const occupied = new Set(Object.keys(bindings))
  return items.map((item) => {
    let token = Object.keys(bindings).find((key) => sameReference(bindings[key]!, item))
    if (!token) {
      let index = 1
      while (occupied.has(`${item.type}${index}`)) index++
      token = `${item.type}${index}`
    }
    occupied.add(token)
    return { ...item, token }
  })
}

/** 服务端只按当前实际输入映射别名；无法证明身份时阻断，绝不退回位置猜测。 */
export function resolveReferenceBindings(
  prompt: string,
  items: ReferenceIdentity[],
  value: unknown,
) {
  const bindings = referenceBindings(value)
  const counts = { image: 0, video: 0, audio: 0 }
  const numbered = items.map((item) => ({ ...item, index: ++counts[item.type] }))
  let text = prompt
  for (const token of videoReferenceTokens(prompt).reverse()) {
    const name = `${token.kind}${token.index}`
    const binding = bindings[name]
    if (!binding) return { error: `引用 @${name} 尚未确认素材身份，请从参考素材重新选择` }
    const current = numbered.find((item) => sameReference(binding, item))
    if (!current) return { error: `引用 @${name} 的素材已删除、替换或未送入，请重新选择` }
    text = text.slice(0, token.start) + `@${current.type}${current.index}` + text.slice(token.end)
  }
  return { prompt: text }
}
