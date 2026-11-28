import { useRef } from 'react'
import { Icon } from '../ui/icons'

export function HomeSearch({
  scope,
  value,
  onChange,
}: {
  scope: '项目' | '画布'
  value: string
  onChange(value: string): void
}) {
  const input = useRef<HTMLInputElement>(null)
  const label = '搜索' + scope
  return (
    <search className="home-search" aria-label={label}>
      <Icon name="search" />
      <input
        type="search"
        ref={input}
        aria-label={label}
        placeholder={label + '名称'}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button
          type="button"
          aria-label={`清除${scope}搜索`}
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn shrink-0"
          onClick={() => {
            onChange('')
            input.current?.focus()
          }}
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </search>
  )
}
