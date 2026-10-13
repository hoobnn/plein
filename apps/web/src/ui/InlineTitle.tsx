import { useRef, useState } from 'react'

/**
 * 就地改名的输入框：回车或失焦提交，Esc 放弃（onDone(null)）。
 * 桌面端（Electron）不支持 window.prompt，改名一律用它。
 */
export function InlineTitle({
  value,
  className = '',
  onDone,
}: {
  value: string
  className?: string
  onDone(title: string | null): void
}) {
  const [draft, setDraft] = useState(value)
  const settled = useRef(false)
  const finish = (title: string | null) => {
    if (settled.current) return
    settled.current = true
    onDone(title?.trim() || null)
  }
  return (
    <input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- 点了「重命名」就是要输入
      autoFocus
      value={draft}
      maxLength={200}
      aria-label="画布名称"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(draft)
        if (e.key === 'Escape') finish(null)
      }}
      className={`bg-surface-2 outline-none ring-1 ring-accent ${className}`}
    />
  )
}
