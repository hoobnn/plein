import { PROFILE_LIMITS, type CharacterProfile } from '@plein/nodes'

/** 先验证目标与容量，再从原时期取出，避免丢失服饰或产生不可保存的档案。 */
export function moveProfileOutfit(
  profile: CharacterProfile,
  from: string,
  outfitId: string,
  to: string,
): CharacterProfile | null {
  const source = profile.periods.find((period) => period.id === from)
  const target = profile.periods.find((period) => period.id === to)
  const outfit = source?.outfits.find((look) => look.id === outfitId)
  if (
    !source ||
    !target ||
    !outfit ||
    from === to ||
    target.outfits.length >= PROFILE_LIMITS.outfits
  )
    return null
  return {
    ...profile,
    periods: profile.periods.map((period) =>
      period.id === from
        ? { ...period, outfits: period.outfits.filter((look) => look.id !== outfitId) }
        : period.id === to
          ? { ...period, outfits: [...period.outfits, outfit] }
          : period,
    ),
  }
}
