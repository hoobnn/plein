import { videoReferenceTokens } from './video-input'

export interface ReferenceIdentity {
  type: 'image' | 'video' | 'audio'
  assetId: string
  source?: string
  /** 来源节点上具体取哪个输出口；旧绑定没有这个字段时按来源 + 类型唯一匹配。 */
  sourcePort?: string
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

  // 旧画布的嵌套绑定表里，值上的 source 也是来源元素 id；复制/导入时一并映射。
  const nested = params.referenceBindings
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    let changed = false
    const entries = Object.entries(nested as Record<string, unknown>).map(([alias, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return [alias, value] as const
      const source = (value as ReferenceIdentity).source
      if (typeof source !== 'string') return [alias, value] as const
      const mapped = ids.get(source)
      if (mapped === undefined || mapped === source) return [alias, value] as const
      changed = true
      return [alias, { ...value, source: mapped }] as const
    })
    if (changed) change('referenceBindings', Object.fromEntries(entries))
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

  // 旧扁平绑定（referenceBinding:别名:来源[:资产]）与 SDK 仍接受的编号键
  // （image1:来源:资产）把来源写在键名里，值上也有一份 source；两边都要映射，
  // 未随复制纳入的外部来源保持原样。
  const remapIdentity = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const source = (value as ReferenceIdentity).source
    if (typeof source !== 'string') return undefined
    const mapped = ids.get(source)
    return mapped === undefined || mapped === source ? undefined : { ...value, source: mapped }
  }
  const remapKey = (key: string) => {
    const legacy = key.startsWith('referenceBinding:')
    const parts = key.split(':')
    // referenceBinding:别名:来源[:资产] 与 image1:来源:资产 的来源位置不同。
    const at = legacy ? 2 : 1
    if (!legacy && !/^(image|video|audio)[1-9]\d*$/.test(parts[0] ?? '')) return undefined
    const source = parts[at]
    if (!source) return undefined
    const mapped = ids.get(source)
    if (mapped === undefined || mapped === source) return undefined
    parts[at] = mapped
    return legacy ? `referenceBinding:${parts.slice(1).join(':')}` : parts.join(':')
  }
  for (const [key, value] of Object.entries(params)) {
    // 只动声明为引用绑定的键；插件自定义参数（如 customModelConfig.source）里的同名字段
    // 不是元素引用，不能按画布 id 重映射。
    const bindingKey =
      key.startsWith('referenceBinding:') || /^(image|video|audio)[1-9]\d*(?::|$)/.test(key)
    if (!bindingKey) continue
    const identity = remapIdentity(value)
    const remappedKey = remapKey(key)
    if (!identity && !remappedKey) continue
    if (next === params) next = { ...params }
    // 新键已被占用时不并到同一名上，避免两个来源挤成一个别名。
    if (remappedKey && remappedKey !== key && !(remappedKey in params)) delete next[key]
    next[remappedKey && !(remappedKey in params) ? remappedKey : key] = identity ?? value
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

/**
 * 绑定和某个实际输出是不是同一份素材。旧绑定没写输出口时只能按来源 + 类型认，
 * 真正的歧义（同源同类型多个口）由调用方用候选数量判断，不能取第一个。
 */
export function sameOutput(binding: ReferenceIdentity, item: ReferenceIdentity) {
  if (binding.type !== item.type || !binding.source || binding.source !== item.source) return false
  return !binding.sourcePort || binding.sourcePort === item.sourcePort
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
    const candidates = numbered.filter((item) =>
      legacy || !binding.source ? sameReference(binding, item) : sameOutput(binding, item),
    )
    const current = binding.sourcePort
      ? candidates.find((item) => item.sourcePort === binding.sourcePort)
      : candidates.length === 1
        ? candidates[0]
        : undefined
    if (!current && candidates.length > 1)
      return { error: `引用 @${name} 对应多个输出，请从参考素材重新选择` }
    if (!current) return { error: `引用 @${name} 的素材已删除、替换或未送入，请重新选择` }
    text = text.slice(0, token.start) + format(current) + text.slice(token.end)
  }
  return { prompt: text }
}
