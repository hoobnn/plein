import { type CharacterProfile, nameProblem } from '@plein/nodes'
import { useId, useLayoutEffect, useState } from 'react'
import { Icon, type IconName } from '../../ui/icons'
import { useProfileFocus } from './profile.utils'

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

/** 预设名的快捷添加：点一下加一项；预设都用过了只剩「自定义」 */
export function PresetChips({
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
export function AddMenu({
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
