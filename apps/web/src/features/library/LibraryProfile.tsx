import {
  type CharacterProfile,
  EXPRESSION_PRESETS,
  OUTFIT_PRESETS,
  PERIOD_PRESETS,
  PROFILE_LIMITS,
  type ProfileLook,
  type ProfilePeriod,
} from '@plein/nodes'
import { useEffect, useState } from 'react'
import type { CanvasMedia } from './canvas'
import { Icon } from '../../ui/icons'
import { SlideSwap } from '../../ui/Slide'
import { moveProfileOutfit } from './profileMoves'
import { freeName } from './freeName'
import { LookGrid } from './LookGrid'
import { OutfitFields, PeriodFields } from './PeriodFields'
import { AddMenu } from './ProfileAdd'
import { ProfileCover } from './ProfileMedia'
import type { HeroControl } from './profile.types'
import { emptyLook, profileControl, useProfileFocus, useProfileHover } from './profile.utils'

export { ProfileImageScope, ProfileUploadContext } from './ProfileMedia'
export type { HeroControl } from './profile.types'

/**
 * 角色档案的编辑：
 * - 时期与服饰：一行一个时期，右边排着这个时期的服饰；点时期改样貌、主音色、次音色，
 *   点服饰改这一套（也能换到别的时期名下）；
 * - 表情：跨时期通用的表情网格。
 * 悬停任意一张图时左侧大图换成它（onPreview），选中的项钉住大图（onPin）。
 */

const emptyPeriod = (name: string): ProfilePeriod => ({
  ...emptyLook(name),
  voice: null,
  voiceStates: [],
  outfits: [],
})

// ── 时期与服饰 ─────────────────────────────────────────

/** 选中的是一个时期，或某个时期下的一套服饰 */
type PeriodSelection = { period: string; outfit?: string }

export function PeriodsTab({
  name,
  profile,
  onChange,
  media,
  hero,
}: {
  /** 角色名，拼引用写法用 */
  name: string
  profile: CharacterProfile
  onChange(next: CharacterProfile): void
  media: CanvasMedia[]
  hero: HeroControl
}) {
  const focus = useProfileFocus()
  const [sel, setSel] = useState<PeriodSelection | null>(() =>
    profile.periods[0] ? { period: profile.periods[0].id } : null,
  )
  const period = profile.periods.find((p) => p.id === sel?.period) ?? profile.periods[0]
  const outfit = period?.outfits.find((o) => o.id === sel?.outfit)
  const index = period ? profile.periods.indexOf(period) : -1
  const hover = useProfileHover(
    profile.periods.flatMap((p) => [
      { id: `period:${p.id}`, assetId: p.images[0], caption: `${p.name}时期` },
      ...p.outfits.map((o) => ({
        id: `outfit:${p.id}:${o.id}`,
        assetId: o.images[0],
        caption: `${p.name} · ${o.name}`,
      })),
    ]),
    hero,
  )

  // 选中项钉住大图：服饰没有图时退回它所属时期的图
  useEffect(() => {
    if (outfit)
      hero.onPin(outfit.images[0] ?? period?.images[0] ?? null, `${period?.name} · ${outfit.name}`)
    else hero.onPin(period?.images[0] ?? null, period ? `${period.name}时期` : undefined)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 只跟选中项和它的首图走
  }, [period?.id, period?.images[0], period?.name, outfit?.id, outfit?.images[0], outfit?.name])

  const setPeriods = (periods: ProfilePeriod[]) => onChange({ ...profile, periods })
  const patchPeriod = (id: string, p: Partial<ProfilePeriod>) =>
    setPeriods(profile.periods.map((x) => (x.id === id ? { ...x, ...p } : x)))
  const addPeriod = (name: string) => {
    const next = emptyPeriod(freeName(profile, name))
    focus.to('input[aria-label="时期名"]')
    setPeriods([...profile.periods, next])
    setSel({ period: next.id })
  }
  const move = (d: -1 | 1) => {
    if (!period) return
    const list = [...profile.periods]
    const j = index + d
    if (j < 0 || j >= list.length) return
    focus.to(profileControl('period', period.id))
    ;[list[index], list[j]] = [list[j]!, list[index]!]
    setPeriods(list)
  }
  const removePeriod = () => {
    if (!period) return
    const rest = profile.periods.filter((x) => x.id !== period.id)
    const near = rest[Math.max(0, index - 1)]
    focus.to(near ? profileControl('period', near.id) : 'button.lib-timeline-add')
    setPeriods(rest)
    setSel(near ? { period: near.id } : null)
  }
  const addOutfit = (owner: ProfilePeriod, name: string) => {
    const look = emptyLook(freeName(profile, name))
    focus.to('input[aria-label="服饰名"]')
    patchPeriod(owner.id, { outfits: [...owner.outfits, look] })
    setSel({ period: owner.id, outfit: look.id })
  }
  const patchOutfit = (p: Partial<ProfileLook>) =>
    period &&
    outfit &&
    patchPeriod(period.id, {
      outfits: period.outfits.map((o) => (o.id === outfit.id ? { ...o, ...p } : o)),
    })
  const removeOutfit = () => {
    if (!period || !outfit) return
    focus.to(profileControl('period', period.id))
    patchPeriod(period.id, { outfits: period.outfits.filter((o) => o.id !== outfit.id) })
    setSel({ period: period.id })
  }
  /** 服饰换到另一个时期名下：名字在整个档案里唯一，挪过去不用改名 */
  const moveOutfit = (to: string) => {
    if (!period || !outfit || to === period.id) return
    const next = moveProfileOutfit(profile, period.id, outfit.id, to)
    if (!next) return
    focus.to('input[aria-label="服饰名"]')
    onChange(next)
    setSel({ period: to, outfit: outfit.id })
  }
  const unused = PERIOD_PRESETS.filter((n) => !profile.periods.some((p) => p.name === n))
  const full = profile.periods.length >= PROFILE_LIMITS.periods
  const outfitsUsed = new Set(profile.periods.flatMap((p) => p.outfits.map((o) => o.name)))

  return (
    <div
      {...focus.props}
      role="group"
      aria-label="时期与服饰编辑"
      className="lib-focus-region flex flex-col gap-4"
    >
      {profile.periods.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          一个角色通常会经历几个时期：童年、少年、青年……每个时期有自己的样貌、一个主音色和几套服饰。
          在提示词里写 <code className="ui-kbd">@角色/少年/校服</code> 就能引用。
        </p>
      ) : (
        <p className="text-xs text-ink-subtle">
          每一行是一个时期，右边是这个时期穿的服饰。点时期改样貌和音色，点服饰改这一套；生成时按「基础设定
          → 时期 → 服饰」叠加。
        </p>
      )}

      <span className="ui-label flex items-center gap-2">
        时期
        <span className="font-normal text-ink-subtle tabular-nums">
          {profile.periods.length}/{PROFILE_LIMITS.periods}
        </span>
      </span>
      {full && (
        <p className="text-xs text-ink-subtle">
          已达 {PROFILE_LIMITS.periods} 个时期上限，删掉一个才能继续添加。
        </p>
      )}

      <ol aria-label="时期与服饰" className="lib-lanes">
        {profile.periods.map((p) => {
          const on = p.id === period?.id
          return (
            <li key={p.id} className="lib-lane" data-active={on || undefined}>
              <button
                type="button"
                data-profile-period={p.id}
                aria-pressed={on && !outfit}
                onClick={() => setSel({ period: p.id })}
                onPointerEnter={() => hover.enter(`period:${p.id}`)}
                onPointerLeave={hover.leave}
                className="lib-lane-period"
              >
                <span className="lib-timeline-thumb">
                  {p.images[0] ? (
                    <ProfileCover id={p.images[0]} />
                  ) : (
                    <Icon name="period" size={16} />
                  )}
                </span>
                <span className="flex min-w-0 flex-col items-start">
                  <span className="max-w-full truncate text-sm font-medium">{p.name}</span>
                  <span className="text-2xs text-ink-subtle tabular-nums">
                    {p.outfits.length ? `${p.outfits.length} 套服饰` : '还没有服饰'}
                  </span>
                </span>
              </button>
              <ul aria-label={`${p.name}的服饰`} className="lib-lane-outfits ui-scrollbar">
                {p.outfits.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      aria-pressed={on && o.id === outfit?.id}
                      aria-label={`${p.name} · ${o.name}`}
                      onClick={() => setSel({ period: p.id, outfit: o.id })}
                      onPointerEnter={() => hover.enter(`outfit:${p.id}:${o.id}`)}
                      onPointerLeave={hover.leave}
                      className="lib-look"
                    >
                      <span className="lib-look-cover">
                        {o.images[0] ? (
                          <ProfileCover id={o.images[0]} />
                        ) : (
                          <Icon name="outfit" size={20} />
                        )}
                        {o.images.length > 1 && (
                          <span className="ui-badge lib-look-count">{o.images.length}</span>
                        )}
                      </span>
                      <span className="truncate px-1 text-xs font-medium">{o.name}</span>
                    </button>
                  </li>
                ))}
                {p.outfits.length < PROFILE_LIMITS.outfits && (
                  <li>
                    <AddMenu
                      label="加服饰"
                      presets={OUTFIT_PRESETS.filter((n) => !outfitsUsed.has(n))}
                      onAdd={(n) => addOutfit(p, n)}
                      icon="outfit"
                      profile={profile}
                      tile
                    />
                  </li>
                )}
                {p.outfits.length >= PROFILE_LIMITS.outfits && (
                  <li className="px-1 text-2xs text-ink-subtle">
                    已达 {PROFILE_LIMITS.outfits} 套服饰上限
                  </li>
                )}
              </ul>
            </li>
          )
        })}
        {!full && (
          <li className="lib-lane lib-lane-add">
            <AddMenu
              label="添加时期"
              presets={unused}
              onAdd={addPeriod}
              placeholder="如：大学"
              icon="period"
              profile={profile}
            />
          </li>
        )}
      </ol>

      {period && (
        <SlideSwap key={`${period.id}:${outfit?.id ?? ''}`} index={index}>
          <div className="lib-look-editor">
            <nav aria-label="当前位置" className="lib-crumbs">
              <button
                type="button"
                disabled={!outfit}
                onClick={() => setSel({ period: period.id })}
                className="lib-crumb"
              >
                <Icon name="period" size={14} />
                {period.name}
              </button>
              {outfit && (
                <>
                  <span className="text-ink-subtle">
                    <Icon name="chevronRight" size={12} />
                  </span>
                  <span className="lib-crumb" aria-current="true">
                    <Icon name="outfit" size={14} />
                    {outfit.name}
                  </span>
                </>
              )}
              <code className="ui-kbd ml-auto truncate">
                @{name}/{period.name}
                {outfit ? `/${outfit.name}` : ''}
              </code>
            </nav>
            {outfit ? (
              <OutfitFields
                key={outfit.id}
                profile={profile}
                period={period}
                outfit={outfit}
                media={media}
                hero={hero}
                onPatch={patchOutfit}
                onMove={moveOutfit}
                onRemove={removeOutfit}
              />
            ) : (
              <PeriodFields
                profile={profile}
                period={period}
                index={index}
                media={media}
                hero={hero}
                onPatch={(p) => patchPeriod(period.id, p)}
                onMove={move}
                onRemove={removePeriod}
              />
            )}
          </div>
        </SlideSwap>
      )}
    </div>
  )
}

// ── 表情 ───────────────────────────────────────────────

export function ExpressionsTab({
  profile,
  onChange,
  media,
  hero,
  sheet,
}: {
  profile: CharacterProfile
  onChange(next: CharacterProfile): void
  media: CanvasMedia[]
  hero: HeroControl
  /** 情绪九宫格槽位（总览图），沿用条目原来的槽位 */
  sheet: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-5">
      {sheet}
      <LookGrid
        title="表情"
        icon="expression"
        profile={profile}
        looks={profile.expressions}
        max={PROFILE_LIMITS.expressions}
        presets={EXPRESSION_PRESETS}
        aspect="square"
        descriptionPlaceholder="眉眼、嘴角和动作，如：眼睛弯成月牙，露出虎牙，微微歪头"
        media={media}
        hero={hero}
        onChange={(expressions) => onChange({ ...profile, expressions })}
      />
    </div>
  )
}

// ── 共用 ───────────────────────────────────────────────
