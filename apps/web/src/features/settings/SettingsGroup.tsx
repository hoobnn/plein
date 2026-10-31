import type { ReactNode } from 'react'

export function Group({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint && <p className="ui-note text-ink-muted">{hint}</p>}
      </div>
      {children}
    </section>
  )
}
