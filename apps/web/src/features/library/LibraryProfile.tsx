import {
  type CharacterProfile,
  EXPRESSION_PRESETS,
  nameProblem,
  noVoice,
  OUTFIT_PRESETS,
  PERIOD_PRESETS,
  PROFILE_LIMITS,
  type ProfileLook,
  type ProfilePeriod,
  profileId,
  renamed,
  VOICE_STATE_PRESETS,
  type VoiceState,
} from '@plein/nodes'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { CanvasMedia } from './canvas'
import { Icon, type IconName } from '../../ui/icons'
import { SlideSwap } from '../../ui/Slide'
import { CanvasPick, thumb, uploadAll, UploadFeedback, useLibraryFieldFocus } from './LibraryFields'
import type { UploadNotice } from './uploadBatch'
import { Select } from '../../ui/Select'
import { VoicePicker } from '../../ui/VoicePicker'
import { moveProfileOutfit } from './profileMoves'
import { freeName } from './freeName'

export const ProfileUploadContext = createContext<{
  pending: boolean
  onBusyChange(busy: boolean): void
}>({ pending: false, onBusyChange: () => {} })

const ImageAttempts = createContext<{
  attempts: Record<string, number>
  retry(id: string): void
}>({ attempts: {}, retry: () => {} })

export function ProfileImageScope({ children }: { children: ReactNode }) {
  const [attempts, setAttempts] = useState<Record<string, number>>({})
  return (
    <ImageAttempts.Provider
      value={{
        attempts,
        retry: (id) => setAttempts((old) => ({ ...old, [id]: (old[id] ?? 0) + 1 })),
      }}
    >
      {children}
    </ImageAttempts.Provider>
  )
}

function ProfileCover({ id }: { id: string }) {
  const { attempts } = useContext(ImageAttempts)
  const token = `${id}:${attempts[id] ?? 0}`
  const current = useRef(token)
  current.current = token
  const [failed, setFailed] = useState<string>()
  const hint = '参考图加载失败，进入编辑后重试'
  return failed === token ? (
    <span role="img" aria-label={hint} title={hint} className="lib-cover-error">
      <Icon name="warning" size={16} />
      <span aria-hidden="true">加载失败</span>
    </span>
  ) : (
    <img
      key={token}
      src={thumb(id)}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => {
        if (current.current === token) setFailed(token)
      }}
    />
  )
}

/**
 * 角色档案的编辑：
 * - 时期与服饰：一行一个时期，右边排着这个时期的服饰；点时期改样貌、主音色、次音色，
 *   点服饰改这一套（也能换到别的时期名下）；
 * - 表情：跨时期通用的表情网格。
 * 悬停任意一张图时左侧大图换成它（onPreview），选中的项钉住大图（onPin）。
 */

/** 档案里的图片悬停 / 选中时告诉外面换大图 */
export interface HeroControl {
  onPreview(assetId: string | null, caption?: string): void
  onPin(assetId: string | null, caption?: string): void
}

/** 按条目身份保留悬停，名称和图片始终从当前草稿读取；删除后自动撤下预览。 */
function useProfileHover(
  items: Array<{ id: string; assetId?: string; caption: string }>,
  hero: HeroControl,
) {
  const [id, setId] = useState<string | null>(null)
  const current = items.find((item) => item.id === id)
  useEffect(() => {
    if (id !== null) hero.onPreview(current?.assetId ?? null, current?.caption)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 依赖当前条目的身份与显示数据，避免新回调触发循环
  }, [id, current?.id, current?.assetId, current?.caption])
  return {
    enter: (id: string) => {
      setId(id)
      const item = items.find((item) => item.id === id)
      hero.onPreview(item?.assetId ?? null, item?.caption)
    },
    leave: () => {
      setId(null)
      hero.onPreview(null)
    },
  }
}

const emptyLook = (name: string): ProfileLook => ({
  id: profileId(),
  name,
  aliases: [],
  description: '',
  images: [],
})

/**
 * 谁占用了这个名字：只说"用过了"用户不知道该改哪一项，这里点名到具体的那一项。
 */
function nameOwner(p: CharacterProfile, name: string): string | null {
  for (const period of p.periods) {
    if (period.name === name || period.aliases.includes(name)) return `时期「${period.name}」`
    for (const outfit of period.outfits)
      if (outfit.name === name || outfit.aliases.includes(name))
        return `服饰「${period.name} · ${outfit.name}」`
    for (const state of period.voiceStates)
      if (state.name === name || state.aliases.includes(name))
        return `次音色「${period.name} · ${state.name}」`
  }
  for (const expression of p.expressions)
    if (expression.name === name || expression.aliases.includes(name))
      return `表情「${expression.name}」`
  return null
}

const emptyPeriod = (name: string): ProfilePeriod => ({
  ...emptyLook(name),
  voice: null,
  voiceStates: [],
  outfits: [],
})

// ── 时期与服饰 ─────────────────────────────────────────

/** 选中的是一个时期，或某个时期下的一套服饰 */
type PeriodSelection = { period: string; outfit?: string }

/** 先停在不会被增删替换的区域，提交后仅在焦点仍归本区域时交接到新控件。 */
function useProfileFocus() {
  const focus = useLibraryFieldFocus()
  const pending = useRef<string | null>(null)
  useLayoutEffect(() => {
    const selector = pending.current
    pending.current = null
    if (!selector || document.activeElement !== focus.props.ref.current) return
    const target = focus.props.ref.current?.querySelector<HTMLElement>(selector)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return {
    ...focus,
    to(selector: string) {
      focus.park()
      pending.current = selector
    },
  }
}

const profileControl = (kind: 'period' | 'look' | 'state', id: string) =>
  `[data-profile-${kind}="${CSS.escape(id)}"]`

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

/** 一个时期自己的设定：名字、样貌、参考图、主音色、状态次音色 */
function PeriodFields({
  profile,
  period,
  index,
  media,
  hero,
  onPatch,
  onMove,
  onRemove,
}: {
  profile: CharacterProfile
  period: ProfilePeriod
  index: number
  media: CanvasMedia[]
  hero: HeroControl
  onPatch(p: Partial<ProfilePeriod>): void
  onMove(d: -1 | 1): void
  onRemove(): void
}) {
  return (
    <>
      <div className="flex items-end gap-2">
        <NameField
          label="时期名"
          profile={profile}
          item={period}
          onRename={(name) => onPatch(renamed(period, name))}
        />
        <div className="flex flex-none gap-1 pb-0.5">
          <button
            type="button"
            aria-label="往前挪"
            title="往前挪"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="ui-btn ui-btn-quiet ui-icon-btn"
          >
            <Icon name="arrowUp" />
          </button>
          <button
            type="button"
            aria-label="往后挪"
            title="往后挪"
            disabled={index === profile.periods.length - 1}
            onClick={() => onMove(1)}
            className="ui-btn ui-btn-quiet ui-icon-btn"
          >
            <Icon name="arrowDown" />
          </button>
          <button
            type="button"
            aria-label={`删除时期「${period.name}」`}
            title={
              period.outfits.length
                ? `删除这个时期和它的 ${period.outfits.length} 套服饰`
                : '删除这个时期'
            }
            onClick={onRemove}
            className="ui-btn ui-btn-quiet ui-icon-btn hover:text-danger"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
      <label className="ui-field">
        <span className="ui-label">这一时期的样子</span>
        <textarea
          className="ui-input h-20"
          value={period.description}
          maxLength={1000}
          placeholder="只写和基础设定不一样的地方：年龄、身高、脸型、发型，如：十五岁，扎高马尾，脸更圆"
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </label>
      <ImageStrip
        label="参考图"
        hint="这一时期的正面全身或半身，生成时排在最前面"
        images={period.images}
        media={media}
        hero={hero}
        onChange={(images) => onPatch({ images })}
      />
      <div className="ui-field">
        <span className="ui-label">主音色</span>
        <VoicePicker
          value={period.voice ?? noVoice}
          onChange={(voice) =>
            onPatch({ voice: voice.provider.trim() || voice.voiceId.trim() ? voice : null })
          }
        />
        <span className="text-xs text-ink-subtle">留空则沿用角色的基础音色</span>
      </div>
      <VoiceStates
        profile={profile}
        states={period.voiceStates}
        onChange={(voiceStates) => onPatch({ voiceStates })}
      />
    </>
  )
}

/** 一套服饰：属于哪个时期、描述、参考图 */
function OutfitFields({
  profile,
  period,
  outfit,
  media,
  hero,
  onPatch,
  onMove,
  onRemove,
}: {
  profile: CharacterProfile
  period: ProfilePeriod
  outfit: ProfileLook
  media: CanvasMedia[]
  hero: HeroControl
  onPatch(p: Partial<ProfileLook>): void
  onMove(periodId: string): void
  onRemove(): void
}) {
  return (
    <>
      <div className="flex items-end gap-2">
        <NameField
          label="服饰名"
          profile={profile}
          item={outfit}
          onRename={(name) => onPatch(renamed(outfit, name))}
        />
        <div className="ui-field w-36 flex-none">
          <span className="ui-label">属于时期</span>
          <Select
            aria-label="属于时期"
            restoreFocusOnSelect={false}
            value={period.id}
            options={profile.periods.map((p) => ({
              value: p.id,
              label:
                p.id !== period.id && p.outfits.length >= PROFILE_LIMITS.outfits
                  ? `${p.name}（服饰已满 ${PROFILE_LIMITS.outfits} 套）`
                  : p.name,
              disabled: p.id !== period.id && p.outfits.length >= PROFILE_LIMITS.outfits,
            }))}
            onChange={onMove}
          />
        </div>
        <button
          type="button"
          aria-label={`删除服饰「${outfit.name}」`}
          title="删除这套服饰"
          onClick={onRemove}
          className="ui-btn ui-btn-quiet ui-icon-btn mb-0.5 flex-none hover:text-danger"
        >
          <Icon name="trash" />
        </button>
      </div>
      <label className="ui-field">
        <span className="ui-label">这套服饰</span>
        <textarea
          className="ui-input h-16"
          value={outfit.description}
          maxLength={1000}
          placeholder="款式、颜色、材质、配饰，如：蓝白运动校服，袖口有校徽，白球鞋"
          onChange={(e) => onPatch({ description: e.target.value })}
        />
        <span className="text-xs text-ink-subtle">
          穿在「{period.name}」时期的样子上：年龄、发型沿用那个时期，这里只写衣着
        </span>
      </label>
      <ImageStrip
        label="参考图"
        hint={`${period.name}时期穿这一套的全身图`}
        images={outfit.images}
        media={media}
        hero={hero}
        onChange={(images) => onPatch({ images })}
      />
    </>
  )
}

/** 状态次音色：生病、醉酒……每行一个名字配一个音色 */
function VoiceStates({
  profile,
  states,
  onChange,
}: {
  profile: CharacterProfile
  states: VoiceState[]
  onChange(next: VoiceState[]): void
}) {
  const focus = useProfileFocus()
  const unused = VOICE_STATE_PRESETS.filter((n) => !states.some((s) => s.name === n))
  const set = (id: string, p: Partial<VoiceState>) =>
    onChange(states.map((s) => (s.id === id ? { ...s, ...p } : s)))
  return (
    <div
      {...focus.props}
      role="group"
      aria-label="状态次音色"
      className="ui-field lib-focus-region"
    >
      <span className="ui-label flex items-center gap-2">
        状态次音色
        <span className="font-normal text-ink-subtle">生病、醉酒等状态下换一个音色</span>
      </span>
      {states.length > 0 && (
        <ul className="flex flex-col gap-2">
          {states.map((s) => (
            <li key={s.id} data-profile-state={s.id} className="lib-row">
              <NameField
                label="状态"
                compact
                profile={profile}
                item={s}
                onRename={(name) => set(s.id, renamed(s, name))}
              />
              <div className="min-w-0 flex-1">
                <VoicePicker value={s.voice} onChange={(voice) => set(s.id, { voice })} />
              </div>
              <button
                type="button"
                aria-label={`删除次音色「${s.name}」`}
                title="删除"
                onClick={() => {
                  const rest = states.filter((x) => x.id !== s.id)
                  const near = rest[Math.min(states.indexOf(s), rest.length - 1)]
                  focus.to(near ? `${profileControl('state', near.id)} input` : 'button.lib-preset')
                  onChange(rest)
                }}
                className="ui-btn ui-btn-quiet ui-icon-btn hover:text-danger"
              >
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {states.length < PROFILE_LIMITS.voiceStates && (
        <PresetChips
          profile={profile}
          presets={unused}
          onAdd={(name) => {
            const state = {
              id: profileId(),
              name: freeName(profile, name),
              aliases: [],
              voice: noVoice,
            }
            focus.to(`${profileControl('state', state.id)} input`)
            onChange([...states, state])
          }}
        />
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

/** 一组造型（服饰或表情）：网格展示，点一张展开编辑 */
function LookGrid({
  title,
  icon,
  profile,
  looks,
  max,
  presets,
  aspect,
  descriptionPlaceholder,
  media,
  hero,
  onChange,
}: {
  title: string
  icon: IconName
  profile: CharacterProfile
  looks: ProfileLook[]
  max: number
  presets: readonly string[]
  aspect: 'portrait' | 'square'
  descriptionPlaceholder: string
  media: CanvasMedia[]
  hero: HeroControl
  onChange(next: ProfileLook[]): void
}) {
  const focus = useProfileFocus()
  const [open, setOpen] = useState<string | null>(null)
  const current = looks.find((l) => l.id === open)
  const hover = useProfileHover(
    looks.map((look) => ({ id: look.id, assetId: look.images[0], caption: look.name })),
    hero,
  )
  const set = (id: string, p: Partial<ProfileLook>) =>
    onChange(looks.map((l) => (l.id === id ? { ...l, ...p } : l)))
  const unused = presets.filter((n) => !looks.some((l) => l.name === n))
  const add = (name: string) => {
    const look = emptyLook(freeName(profile, name))
    focus.to('input[aria-label="名字"]')
    onChange([...looks, look])
    setOpen(look.id)
  }

  useEffect(() => {
    hero.onPin(current?.images[0] ?? null, current?.name)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- 跟展开项、首图及名称走，收起时清除固定预览
  }, [current?.id, current?.images[0], current?.name])

  return (
    <div
      {...focus.props}
      role="group"
      aria-label={`${title}编辑`}
      className="ui-field lib-focus-region"
    >
      <span className="ui-label flex items-center gap-2">
        {title}
        <span className="font-normal text-ink-subtle tabular-nums">
          {looks.length}/{max}
        </span>
      </span>
      <ul className={`lib-look-grid ${aspect === 'square' ? 'is-square' : ''}`}>
        {looks.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              data-profile-look={l.id}
              aria-pressed={l.id === open}
              aria-label={`编辑「${l.name}」`}
              onClick={() => setOpen(l.id === open ? null : l.id)}
              onPointerEnter={() => hover.enter(l.id)}
              onPointerLeave={hover.leave}
              className="lib-look"
            >
              <span className="lib-look-cover">
                {l.images[0] ? <ProfileCover id={l.images[0]} /> : <Icon name={icon} size={20} />}
                {l.images.length > 1 && (
                  <span className="ui-badge lib-look-count">{l.images.length}</span>
                )}
              </span>
              <span className="truncate px-1 text-xs font-medium">{l.name}</span>
            </button>
          </li>
        ))}
        {looks.length < max && (
          <li>
            <AddMenu
              label={`添加${title}`}
              presets={unused}
              onAdd={add}
              icon={icon}
              profile={profile}
              tile
            />
          </li>
        )}
      </ul>
      {current && (
        <div key={current.id} className="lib-look-editor">
          <div className="flex items-end gap-2">
            <NameField
              label="名字"
              profile={profile}
              item={current}
              onRename={(name) => set(current.id, renamed(current, name))}
            />
            <button
              type="button"
              onClick={() => {
                const rest = looks.filter((l) => l.id !== current.id)
                const near = rest[Math.min(looks.indexOf(current), rest.length - 1)]
                focus.to(near ? profileControl('look', near.id) : 'button.lib-look-add')
                onChange(rest)
                setOpen(null)
                hero.onPin(null)
              }}
              className="ui-btn ui-btn-quiet mb-0.5 hover:text-danger"
            >
              <Icon name="trash" />
              删除
            </button>
          </div>
          <label className="ui-field">
            <span className="ui-label">描述</span>
            <textarea
              className="ui-input h-16"
              value={current.description}
              maxLength={1000}
              placeholder={descriptionPlaceholder}
              onChange={(e) => set(current.id, { description: e.target.value })}
            />
          </label>
          <ImageStrip
            label="参考图"
            images={current.images}
            media={media}
            hero={hero}
            onChange={(images) => set(current.id, { images })}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 名字输入：失焦或回车时才提交，旧名记进 aliases；重名、含 / 等时就地提示，不提交。
 */
function NameField({
  label,
  profile,
  item,
  onRename,
  compact = false,
}: {
  label: string
  profile: CharacterProfile
  item: { id: string; name: string; aliases: string[] }
  onRename(name: string): void
  compact?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(item.name)
  const [problem, setProblem] = useState<string | undefined>()
  const problemId = useId()
  useLayoutEffect(() => {
    if (document.activeElement === ref.current)
      ref.current?.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [problem, item.name])
  useEffect(() => {
    setDraft(item.name)
    setProblem(undefined)
  }, [item.id, item.name])
  const commit = () => {
    const next = draft.trim()
    if (next === item.name) return setProblem(undefined)
    const p = nameProblem(profile, next, item.id)
    setProblem(p)
    if (!p) onRename(next)
  }
  const input = (
    <input
      ref={ref}
      className={`ui-input ${compact ? 'w-24' : ''}`}
      aria-label={label}
      aria-invalid={!!problem}
      aria-describedby={problem ? problemId : undefined}
      data-library-escape={draft !== item.name || problem ? '' : undefined}
      value={draft}
      maxLength={20}
      onChange={(e) => {
        setDraft(e.target.value)
        setProblem(undefined)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) {
          e.stopPropagation()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setDraft(item.name)
          setProblem(undefined)
        }
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          commit()
        }
      }}
    />
  )
  if (compact)
    return (
      <span className="flex flex-none flex-col" title={problem}>
        {input}
        {problem && (
          <span id={problemId} role="alert" className="max-w-24 text-xs text-danger">
            {problem}
          </span>
        )}
      </span>
    )
  return (
    <label className="ui-field min-w-0 flex-1">
      <span className="ui-label">{label}</span>
      {input}
      {problem ? (
        <span id={problemId} role="alert" className="text-xs text-danger">
          {problem}
        </span>
      ) : item.aliases.length ? (
        <span className="text-xs text-ink-subtle">旧名 {item.aliases.join('、')} 仍可引用</span>
      ) : null}
    </label>
  )
}

function ProfileImage({ id, hero, onRemove }: { id: string; hero: HeroControl; onRemove(): void }) {
  const group = useRef<HTMLDivElement>(null)
  const { attempts, retry } = useContext(ImageAttempts)
  const attempt = attempts[id] ?? 0
  const [failed, setFailed] = useState<number>()
  const current = useRef(attempt)
  current.current = attempt
  return (
    <div
      ref={group}
      role="group"
      aria-label="档案参考图"
      tabIndex={-1}
      className="lib-strip-tile lib-focus-region group"
      onPointerEnter={() => hero.onPreview(id)}
      onPointerLeave={() => hero.onPreview(null)}
    >
      {failed === attempt ? (
        <div className="flex h-full flex-col items-center justify-end pb-1 text-xs text-ink-subtle">
          <span role="status">加载失败</span>
          <button
            type="button"
            aria-label="重新加载图片"
            className="ui-btn ui-btn-quiet ui-btn-xs"
            onClick={(event) => {
              if (document.activeElement === event.currentTarget) group.current?.focus()
              retry(id)
            }}
          >
            <Icon name="retry" size={12} />
            重试
          </button>
        </div>
      ) : (
        <img
          key={attempt}
          src={thumb(id)}
          alt=""
          draggable={false}
          onError={() => {
            if (attempt === current.current) setFailed(attempt)
          }}
        />
      )}
      <button
        type="button"
        aria-label="移除"
        title="移除"
        onClick={onRemove}
        className="ui-btn ui-btn-quiet ui-btn-xs ui-icon-btn absolute top-1 right-1 bg-float opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/** 最多 4 张的参考图条：72 小图，悬停换大图 */
function ImageStrip({
  label,
  hint,
  images,
  media,
  hero,
  onChange,
}: {
  label: string
  hint?: string
  images: string[]
  media: CanvasMedia[]
  hero: HeroControl
  onChange(next: string[]): void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const focus = useLibraryFieldFocus()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<UploadNotice | null>(null)
  const uploads = useContext(ProfileUploadContext)
  const room = PROFILE_LIMITS.images - images.length
  const add = (ids: string[]) =>
    onChange([...new Set([...images, ...ids])].slice(0, PROFILE_LIMITS.images))
  const upload = async (files: File[]) => {
    if (!files.length || busy || uploads.pending) return
    if (focus.props.ref.current?.contains(document.activeElement)) focus.park()
    setBusy(true)
    uploads.onBusyChange(true)
    setFeedback(null)
    try {
      const result = await uploadAll(files, 'image', { capacity: room, used: images })
      if (result.ids.length) add(result.ids)
      setFeedback(result)
    } catch (err) {
      setFeedback({ message: (err as Error).message, failed: true })
    } finally {
      setBusy(false)
      uploads.onBusyChange(false)
    }
  }
  return (
    <div {...focus.props} role="group" aria-label={label} className="ui-field lib-focus-region">
      <span className="ui-label flex min-w-0 items-baseline gap-2" title={hint}>
        <span className="flex-none">{label}</span>
        <span className="font-normal text-ink-subtle tabular-nums">
          {images.length}/{PROFILE_LIMITS.images}
        </span>
        {hint && <span className="truncate font-normal text-ink-subtle">{hint}</span>}
      </span>
      <div className="flex flex-wrap gap-2">
        {images.map((id) => (
          <ProfileImage
            key={id}
            id={id}
            hero={hero}
            onRemove={() => {
              focus.park()
              onChange(images.filter((x) => x !== id))
            }}
          />
        ))}
        {room > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => ref.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void upload([...e.dataTransfer.files])
            }}
            className="ui-drop-tile lib-strip-add"
          >
            <Icon name={busy ? 'upload' : 'plus'} size={16} />
            {busy ? '上传中' : '上传'}
          </button>
        )}
        {room > 0 && (
          <CanvasPick
            disabled={busy || uploads.pending || room <= 0}
            media={media}
            type="image"
            multiple
            taken={images}
            onPick={(id) => {
              if (room === 1) focus.park()
              setFeedback(null)
              add([id])
            }}
          />
        )}
      </div>
      <UploadFeedback value={feedback} />
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple
        hidden
        disabled={busy || uploads.pending || room <= 0}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          void upload(files)
        }}
      />
    </div>
  )
}

/** 预设名的快捷添加：点一下加一项；预设都用过了只剩「自定义」 */
function PresetChips({
  profile,
  presets,
  onAdd,
}: {
  /** 新名字要跟整个档案比重名，光看预设列表会漏掉已有的时期和表情 */
  profile: CharacterProfile
  presets: readonly string[]
  onAdd(name: string): void
}) {
  const focus = useProfileFocus()
  const [custom, setCustom] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | undefined>()
  const problemId = useId()
  const editingCustom = custom !== null
  useLayoutEffect(() => {
    const field = focus.props.ref.current
    if (!editingCustom || !field?.contains(document.activeElement)) return
    const menu = field.closest<HTMLElement>('.lib-add-pop')
    const viewport = menu?.closest<HTMLElement>('.lib-editor-content')
    if (!menu || !viewport) return
    // 自动聚焦只保证输入框可见；输入或窗口变化后同时露出整个菜单。
    const reveal = () => {
      if (field.contains(document.activeElement) && menu.offsetHeight <= viewport.clientHeight)
        menu.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    reveal()
    const resize = new ResizeObserver(reveal)
    resize.observe(menu)
    resize.observe(viewport)
    return () => resize.disconnect()
  }, [editingCustom, problem, focus.props.ref])
  return (
    <div
      {...focus.props}
      role="group"
      aria-label="快捷添加"
      className="lib-focus-region flex flex-wrap items-center gap-1.5"
    >
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => {
            focus.to('[data-profile-custom]')
            onAdd(p)
          }}
          className="ui-chip lib-preset"
        >
          <Icon name="plus" size={12} />
          {p}
        </button>
      ))}
      {custom === null ? (
        <button
          type="button"
          data-profile-custom=""
          onClick={() => setCustom('')}
          className="ui-chip lib-preset"
        >
          <Icon name="pencil" size={12} />
          自定义
        </button>
      ) : (
        <span className="flex flex-col gap-1">
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- 点了「自定义」就是要马上输入
            autoFocus
            className="ui-input ui-input-xs w-28"
            aria-label="自定义名字"
            aria-invalid={!!problem}
            aria-describedby={problem ? problemId : undefined}
            data-library-escape=""
            placeholder="回车添加"
            value={custom}
            maxLength={20}
            onChange={(e) => {
              setCustom(e.target.value)
              setProblem(undefined)
            }}
            onBlur={() => {
              setCustom(null)
              setProblem(undefined)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) {
                e.stopPropagation()
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                focus.to('[data-profile-custom]')
                setCustom(null)
                setProblem(undefined)
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                const next = custom.trim()
                const error = nameProblem(profile, next)
                const owner = error ? nameOwner(profile, next) : null
                setProblem(owner ? `${error}（已被${owner}占用）` : error)
                if (error) return
                focus.to('[data-profile-custom]')
                onAdd(next)
                setCustom(null)
              }
            }}
          />
          {problem && (
            <span id={problemId} role="alert" className="max-w-28 text-xs text-danger">
              {problem}
            </span>
          )}
        </span>
      )}
    </div>
  )
}

/** 「添加」按钮：展开后是预设名和自定义输入，tile 时是网格里的一格 */
function AddMenu({
  label,
  presets,
  onAdd,
  icon,
  placeholder,
  profile,
  tile = false,
}: {
  label: string
  presets: readonly string[]
  onAdd(name: string): void
  icon: IconName
  placeholder?: string
  /** 传给自定义输入，用来跟整个档案比重名 */
  profile: CharacterProfile
  tile?: boolean
}) {
  const [open, setOpen] = useState(false)
  const focus = useProfileFocus()
  const collapse = () => {
    focus.to('button')
    setOpen(false)
  }
  return (
    <div
      {...focus.props}
      role="group"
      aria-label={label}
      className={`lib-focus-region ${open ? `lib-add-pop ui-pop ${tile ? 'is-tile' : ''}` : ''}`}
      data-side="below"
      data-library-escape={open ? '' : undefined}
      onKeyDown={(e) => {
        if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          collapse()
        }
      }}
    >
      {open ? (
        <>
          <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <Icon name={icon} size={14} />
            {label}
            <button
              type="button"
              aria-label="收起"
              onClick={collapse}
              className="ui-btn ui-btn-quiet ui-btn-xs ui-icon-btn ml-auto"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <PresetChips
            profile={profile}
            presets={presets}
            onAdd={(n) => {
              collapse()
              onAdd(n)
            }}
          />
          {placeholder && <span className="sr-only">{placeholder}</span>}
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            focus.to('button.lib-preset')
            setOpen(true)
          }}
          className={tile ? 'lib-look lib-look-add' : 'lib-timeline-node lib-timeline-add'}
        >
          <span className={tile ? 'lib-look-cover' : 'lib-timeline-thumb'}>
            <Icon name="plus" size={16} />
          </span>
          <span className="truncate px-1 text-xs">{label}</span>
        </button>
      )}
    </div>
  )
}
