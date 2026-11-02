import { type CharacterProfile, type ProfileLook, renamed } from '@plein/nodes'
import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../../ui/icons'
import type { CanvasMedia } from './canvas'
import { freeName } from './freeName'
import { NameField } from './NameField'
import { AddMenu } from './ProfileAdd'
import { ImageStrip, ProfileCover } from './ProfileMedia'
import type { HeroControl } from './profile.types'
import { emptyLook, profileControl, useProfileFocus, useProfileHover } from './profile.utils'

/** 一组造型（服饰或表情）：网格展示，点一张展开编辑 */
export function LookGrid({
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
