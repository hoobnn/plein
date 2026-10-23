import { type CharacterProfile, profileNames } from '@plein/nodes'

/** 同一个角色里不重名：预设名被占用时加序号 */
export function freeName(profile: CharacterProfile, base: string) {
  // 调用方已校验基础名；自动序号也必须遵守 20 字符上限并避开全部旧名。
  const used = profileNames(profile)
  if (!used.has(base)) return base
  const stem = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(base),
    (part) => part.segment,
  )
  for (let i = 2; ; i++) {
    const suffix = String(i)
    while (stem.join('').length + suffix.length > 20) stem.pop()
    const next = `${stem.join('')}${suffix}`
    if (!used.has(next)) return next
  }
}
