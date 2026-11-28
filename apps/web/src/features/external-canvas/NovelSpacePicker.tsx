import type { ExternalSpace } from '@plein/protocol'
import { useId, useState } from 'react'
import { Select } from '../../ui/Select'

export function NovelSpacePicker({
  value,
  spaces,
  disabled,
  onToggle,
  onChange,
}: {
  value: string
  spaces: ExternalSpace[] | null
  disabled: boolean
  onToggle(open: boolean): void
  onChange(value: string): void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const selected = spaces?.find((s) => s.id === value)
  return (
    <>
      <button
        type="button"
        className="ui-btn ui-btn-quiet ui-btn-sm max-w-full"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setOpen(!open)
          onToggle(!open)
        }}
      >
        <span className="truncate">
          {!open && selected ? `短剧空间 · ${selected.title || selected.id}` : '选择短剧空间'}
        </span>
      </button>
      <span id={id} hidden={!open} className="min-w-0 max-w-full">
        {open &&
          spaces &&
          (spaces.length ? (
            <Select
              aria-label="短剧空间"
              value={value}
              disabled={disabled}
              className="max-w-full"
              options={[
                { value: '', label: '使用默认空间' },
                ...spaces.map((s) => ({
                  value: s.id,
                  label: (s.title || s.id) + (s.current ? '（当前）' : ''),
                })),
              ]}
              onChange={onChange}
            />
          ) : (
            <span className="text-xs text-ink-muted">当前账号没有可选空间</span>
          ))}
      </span>
    </>
  )
}
