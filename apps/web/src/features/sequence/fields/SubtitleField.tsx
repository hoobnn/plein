import { useId, useRef, useState } from 'react'

/** 字幕：留空用对白的台词；失焦时写入 */
export function SubtitleField(props: {
  value: string | undefined
  readValue(): string | undefined
  placeholder: string
  onChange(v: string | undefined): void
}) {
  const [draft, setDraft] = useState<{ text: string; base: string | undefined } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const conflictId = useId()
  const current = props.readValue()
  const conflict = draft !== null && draft.base !== current
  const commit = (force = false) => {
    if (draft === null) return
    if (!force && draft.base !== props.readValue()) {
      setDraft({ ...draft })
      return
    }
    const value = draft.text.trim()
    setDraft(null)
    props.onChange(value || undefined)
  }
  return (
    <div className="space-y-2">
      <input
        ref={input}
        aria-label="字幕"
        aria-describedby={conflict ? conflictId : undefined}
        className="ui-input w-full"
        value={draft?.text ?? props.value ?? ''}
        placeholder={props.placeholder}
        onChange={(e) => {
          const text = e.target.value
          setDraft((previous) => ({ text, base: previous ? previous.base : props.readValue() }))
        }}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {conflict && (
        <div className="space-y-2 rounded-lg bg-surface-2 p-2">
          <p id={conflictId} role="status" className="text-xs text-ink-muted">
            字幕已更新，当前草稿尚未保存。
          </p>
          <p className="max-h-24 overflow-y-auto text-xs break-words text-ink-muted">
            最新字幕：{current || '自动使用台词'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                setDraft(null)
                input.current?.focus()
              }}
            >
              使用最新字幕
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() => {
                input.current?.focus()
                commit(true)
              }}
            >
              保留当前字幕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
