import type { MentionTarget } from '@plein/nodes'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { mentionParts } from '../canvas/mentionText'

/** 两行摘要中的引用可以单独定位；被截掉的引用不进入键盘导航。 */
export function BoardTextPreview({
  text,
  targets,
  onLocate,
  source,
}: {
  text: string
  targets: readonly MentionTarget[]
  onLocate(id: string): void
  source: RefObject<HTMLButtonElement | null>
}) {
  const root = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const preview = root.current
    if (!preview) return
    const sync = () => {
      const bounds = preview.getBoundingClientRect()
      for (const mark of preview.querySelectorAll<HTMLElement>('mark')) {
        const visible = [...mark.getClientRects()].some(
          (r) =>
            r.top < bounds.bottom - 1 &&
            r.bottom > bounds.top + 1 &&
            r.left < bounds.right &&
            r.right > bounds.left,
        )
        if ((!visible || !mark.dataset.mentionId) && mark.contains(document.activeElement))
          source.current?.focus()
        mark.inert = !visible
        mark.setAttribute('aria-hidden', String(!visible))
      }
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(preview)
    return () => observer.disconnect()
  })
  return (
    <span
      ref={root}
      className="mt-0.5 line-clamp-2 text-xs leading-relaxed break-words whitespace-pre-line text-ink-subtle"
    >
      {mentionParts(text, targets).map((part) =>
        part.mention ? (
          <mark
            key={part.start}
            className="plein-mention relative z-10"
            data-state={part.missing ? 'missing' : part.warning ? 'warning' : 'resolved'}
            data-mention-id={part.id}
            title={part.warning ?? (part.id ? `点击定位「${part.text}」` : undefined)}
            role={part.id ? 'button' : undefined}
            tabIndex={part.id ? 0 : -1}
            onClick={part.id ? () => onLocate(part.id!) : undefined}
            onKeyDown={
              part.id
                ? (event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onLocate(part.id!)
                    }
                  }
                : undefined
            }
          >
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </span>
  )
}
