import {
  type CharacterProfile,
  noVoice,
  PROFILE_LIMITS,
  type ProfileLook,
  type ProfilePeriod,
  profileId,
  renamed,
  VOICE_STATE_PRESETS,
  type VoiceState,
} from '@plein/nodes'
import { Icon } from '../../ui/icons'
import { Select } from '../../ui/Select'
import { VoicePicker } from '../../ui/VoicePicker'
import type { CanvasMedia } from './canvas'
import { freeName } from './freeName'
import { NameField } from './NameField'
import { ImageStrip } from './ProfileMedia'
import { PresetChips } from './ProfileAdd'
import type { HeroControl } from './profile.types'
import { profileControl, useProfileFocus } from './profile.utils'

/** 一个时期自己的设定：名字、样貌、参考图、主音色、状态次音色 */
export function PeriodFields({
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
export function OutfitFields({
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
export function VoiceStates({
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
