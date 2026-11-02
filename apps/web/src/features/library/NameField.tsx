import { type CharacterProfile, nameProblem } from '@plein/nodes'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/**
 * 名字输入：失焦或回车时才提交，旧名记进 aliases；重名、含 / 等时就地提示，不提交。
 */
export function NameField({
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
