import { useState } from 'react'
import { Icon } from './icons'
import { Popover } from './Popover'

/** 轻量下拉：文字 + ▾ 的安静按钮，弹出单选菜单。用在侧栏、故事板列头这类工具位 */
export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange(value: T): void
  label: string
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={label}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className="ui-btn ui-btn-quiet ui-btn-sm gap-1 px-2 text-ink-muted"
      >
        {current?.label}
        <Icon name="chevronDown" size={12} />
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          width={160}
          label={label}
          placement="below"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={o.value === value}
              onClick={() => {
                onChange(o.value)
                setAnchor(null)
              }}
              className="ui-menu-item"
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.value === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </Popover>
      )}
    </>
  )
}
