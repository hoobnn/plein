import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { Popover } from './Popover'

export interface SelectOption {
  value: string
  label?: string
}

/** 下拉选择：替代原生 <select>，弹层与应用里其他菜单一致 */
export function Select({
  id,
  value,
  options,
  onChange,
  className = '',
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string
  options: SelectOption[]
  onChange(value: string): void
  className?: string
  'aria-label'?: string
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  const close = () => setAnchor(null)
  const pick = (v: string) => {
    onChange(v)
    close()
    anchor?.focus()
  }

  useEffect(() => {
    if (!anchor) return
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    )
  }, [anchor, options, value])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({
      block: 'nearest',
    })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!anchor) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        setAnchor(e.currentTarget as HTMLButtonElement)
      }
      return
    }
    if (e.key === 'ArrowDown') setActive((i) => Math.min(options.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
    else if (e.key === 'Enter' || e.key === ' ') {
      const o = options[active]
      if (o) pick(o.value)
    } else if (e.key === 'Tab') close()
    else return
    e.preventDefault()
  }

  return (
    <>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        aria-label={ariaLabel}
        onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget))}
        onKeyDown={onKeyDown}
        className={`ui-select truncate text-left ${className}`}
      >
        {current?.label ?? current?.value ?? value}
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={close}
          width={Math.max(anchor.offsetWidth, 160)}
          label={ariaLabel ?? '选择'}
          placement="below"
        >
          <div ref={listRef} role="listbox" aria-label={ariaLabel}>
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                data-index={i}
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
                className="ui-menu-item"
              >
                <span className="min-w-0 flex-1 truncate">{o.label ?? o.value}</span>
                {o.value === value && (
                  <span className="text-accent">
                    <Icon name="check" size={14} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}
