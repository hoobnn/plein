import { videoReferenceTokens } from './video-input'

export interface ReferenceIdentity {
  type: 'image' | 'video' | 'audio'
  assetId: string
  source?: string
}
export type ReferenceBindings = Record<string, ReferenceIdentity>

/** 复制或导入时，重映射引用参数里保存的元素 id；未纳入映射的外部依赖保持原样。 */
export function remapReferenceParams(
  params: Record<string, unknown>,
  ids: ReadonlyMap<string, string>,
): Record<string, unknown> {
  let next = params
  const change = (key: string, value: unknown) => {
    if (next === params) next = { ...params }
    next[key] = value
  }
  const ref = (value: unknown) => (typeof value === 'string' ? (ids.get(value) ?? value) : value)

  const required = params.requiredRefs
  if (Array.isArray(required)) {
    const requiredRefs = required.map(ref)
    if (requiredRefs.some((value, index) => value !== required[index]))
      change('requiredRefs', requiredRefs)
  }

  const picks = params.referenceImagePicks
  if (picks && typeof picks === 'object' && !Array.isArray(picks)) {
    let changed = false
    const entries = Object.entries(picks).map(([key, value]) => {
      const mapped = ids.get(key)
      if (mapped !== undefined && mapped !== key) changed = true
      return [mapped ?? key, value] as const
    })
    if (changed) change('referenceImagePicks', Object.fromEntries(entries))
  }

  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith('referenceNameBinding:')) continue
    const separator = key.lastIndexOf(':')
    if (separator < 'referenceNameBinding:'.length) continue
    const source = key.slice(separator + 1)
    const mapped = ids.get(source)
    if (mapped === undefined || mapped === source) continue
    if (next === params) next = { ...params }
    delete next[key]
    next[`${key.slice(0, separator + 1)}${mapped}`] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'source' in value &&
      value.source === source
        ? { ...value, source: mapped }
        : value
  }
  return next
}

/** 兼容旧编号绑定；名称引用绑定来源，迭代时使用该来源当前的结果。 */
export function referenceBindings(value: unknown): ReferenceBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const nested = record.referenceBindings
  const entries = Object.entries(
    nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {},
  )
  const namedEntries: Array<[string, unknown]> = []
  for (const [key, item] of Object.entries(record)) {
    if (key.startsWith('referenceNameBinding:')) {
      try {
        namedEntries.push([
          decodeURIComponent(key.slice('referenceNameBinding:'.length).split(':')[0]!),
          item,
        ])
      } catch {
        // 损坏的编码不影响其他素材引用。
      }
    } else if (key.startsWith('referenceBinding:'))
      entries.push([key.slice('referenceBinding:'.length), item])
    else if (/^(image|video|audio)[1-9]\d*(?::|$)/.test(key)) entries.push([key, item])
  }
  const namedKeys = new Set(namedEntries.map(([name]) => name))
  const result: ReferenceBindings = Object.create(null)
  for (const [key, item] of [
    ...entries
      .map(
        ([entry, item]) =>
          [
            /^(image|video|audio)[1-9]\d*:/.test(entry) ? entry.split(':')[0]! : entry,
            item,
          ] as const,
      )
      .filter(([name]) => !namedKeys.has(name)),
    ...namedEntries,
  ]) {
    if (!key || !item || typeof item !== 'object') continue
    const identity = item as ReferenceIdentity
    if (
      !['image', 'video', 'audio'].includes(identity.type) ||
      typeof identity.assetId !== 'string' ||
      (identity.source !== undefined && typeof identity.source !== 'string') ||
      (/^(image|video|audio)[1-9]\d*$/.test(key) && !key.startsWith(identity.type))
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
  const bindings = Object.fromEntries(
    Object.entries(referenceBindings(value)).filter(([key]) =>
      /^(image|video|audio)[1-9]\d*$/.test(key),
    ),
  )
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

/** 用户写下的素材名称和旧编号；文件名中的空格、点号不截断。 */
export function boundReferenceTokens(prompt: string, value: unknown) {
  const bindings = referenceBindings(value)
  const names = Object.keys(bindings).sort((a, b) => b.length - a.length)
  const tokens = videoReferenceTokens(prompt).map((t) => ({ ...t, name: `${t.kind}${t.index}` }))
  for (let start = prompt.indexOf('@'); start >= 0; start = prompt.indexOf('@', start + 1)) {
    if (/[a-zA-Z0-9._%+@-]/.test(prompt[start - 1] ?? '')) continue
    let slashes = 0
    for (let i = start - 1; i >= 0 && prompt[i] === '\\'; i--) slashes++
    if (slashes % 2) continue
    const name = names.find(
      (name) =>
        prompt.startsWith(name, start + 1) &&
        !/[a-zA-Z0-9_.%+#-]/.test(prompt[start + 1 + name.length] ?? ''),
    )
    if (!name) continue
    const existing = tokens.findIndex((t) => t.start === start)
    if (existing >= 0) tokens.splice(existing, 1)
    tokens.push({ start, end: start + 1 + name.length, name, kind: bindings[name]!.type, index: 0 })
  }
  return tokens
    .sort((a, b) => a.start - b.start)
    .filter((t, i, all) => !all.slice(0, i).some((previous) => previous.end > t.start))
}

/** 服务端只按当前实际输入映射别名；无法证明身份时阻断，绝不退回位置猜测。 */
export function resolveReferenceBindings(
  prompt: string,
  items: ReferenceIdentity[],
  value: unknown,
  format: (item: ReferenceIdentity & { index: number }) => string = (item) =>
    `@${item.type}${item.index}`,
) {
  const bindings = referenceBindings(value)
  const counts = { image: 0, video: 0, audio: 0 }
  const numbered = items.map((item) => ({ ...item, index: ++counts[item.type] }))
  let text = prompt
  for (const token of boundReferenceTokens(prompt, value).reverse()) {
    const name = token.name
    const binding = bindings[name]
    if (!binding) return { error: `引用 @${name} 尚未确认素材身份，请从参考素材重新选择` }
    const named =
      value &&
      typeof value === 'object' &&
      Object.keys(value).some((key) =>
        key.startsWith(`referenceNameBinding:${encodeURIComponent(name)}:`),
      )
    const legacy = !named && /^(image|video|audio)[1-9]\d*$/.test(name)
    const current = numbered.find((item) =>
      legacy || !binding.source
        ? sameReference(binding, item)
        : binding.source === item.source && binding.type === item.type,
    )
    if (!current) return { error: `引用 @${name} 的素材已删除、替换或未送入，请重新选择` }
    text = text.slice(0, token.start) + format(current) + text.slice(token.end)
  }
  return { prompt: text }
}
