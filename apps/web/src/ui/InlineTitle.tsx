import { useRef, useState } from 'react'

/**
 * 就地改名的输入框：回车或失焦提交，Esc 放弃（onDone(null)）。
 * 桌面端（Electron）不支持 window.prompt，改名一律用它。
 */
export function InlineTitle({
  value,
  className = '',
  label = '画布名称',
  autoFocus = true,
  onDone,
}: {
  value: string
  className?: string
  label?: string
  autoFocus?: boolean
  /** 返回最新基线时保留输入，供用户确认后再次提交。 */
  onDone(title: string | null, expected: string): { expected: string } | void | Promise<void>
}) {
  const [editing, setEditing] = useState({ draft: value, source: value, baseline: value })
  if (editing.source !== value) {
    const pristine = editing.draft === editing.source
    setEditing({
      source: value,
      draft: pristine ? value : editing.draft,
      baseline: pristine ? value : editing.baseline,
    })
  }
  const settled = useRef(false)
  const finish = (title: string | null) => {
    if (settled.current) return
    settled.current = true
    const conflict = onDone(title?.trim() || null, editing.baseline)
    if (conflict && 'expected' in conflict) {
      setEditing((current) => ({ ...current, baseline: conflict.expected }))
      settled.current = false
    }
  }
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- 点了「重命名」就是要输入
      autoFocus={autoFocus}
      value={editing.draft}
      maxLength={200}
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
      onBlur={() => finish(editing.draft)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
        if (e.key === 'Enter') finish(editing.draft)
        if (e.key === 'Escape') finish(null)
      }}
      className={`bg-surface-2 outline-none ring-1 ring-accent ${className}`}
    />
  )
}
