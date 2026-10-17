import type { MentionTarget } from '@plein/nodes'
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithRef,
} from 'react'
import { mentionParts } from '../canvas/mentionText'

/** 保留原生 textarea 的输入、选择、IME 与复制行为，镜像层显示正文和引用颜色。 */
export function MentionTextarea({
  ref,
  value,
  targets,
  onScroll,
  onClick,
  onPointerMove,
  onLocate,
  ...props
}: Omit<ComponentPropsWithRef<'textarea'>, 'value'> & {
  value: string
  targets: readonly MentionTarget[]
  onLocate?(id: string): void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => input.current!)
  const sync = useCallback(() => {
    const ta = input.current
    const box = layer.current
    const body = content.current
    if (!ta || !box || !body) return
    const style = getComputedStyle(ta)
    for (const key of [
      'font',
      'lineHeight',
      'letterSpacing',
      'wordSpacing',
      'textAlign',
      'textIndent',
      'textTransform',
      'padding',
      'tabSize',
      'direction',
    ] as const)
      body.style[key] = style[key]
    box.style.width = `${ta.clientWidth}px`
    box.style.height = `${ta.clientHeight}px`
    box.style.left = `${ta.offsetLeft + ta.clientLeft}px`
    box.style.top = `${ta.offsetTop + ta.clientTop}px`
    body.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
  }, [])
  useLayoutEffect(sync)
  useLayoutEffect(() => {
    const observer = new ResizeObserver(sync)
    if (input.current) observer.observe(input.current)
    return () => observer.disconnect()
  }, [sync])
  return (
    <div className="plein-mention-input relative min-w-0">
      <textarea
        {...props}
        ref={input}
        value={value}
        onClick={(event) => {
          onClick?.(event)
          if (!onLocate || (!event.metaKey && !event.ctrlKey)) return
          const at = event.currentTarget.selectionStart
          const part = mentionParts(value, targets).find(
            (p) => p.mention && at >= p.start && at < p.start + p.text.length,
          )
          if (part?.id) {
            event.preventDefault()
            onLocate(part.id)
          }
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event)
          const hit = [...(layer.current?.querySelectorAll('mark') ?? [])].find((mark) =>
            [...mark.getClientRects()].some(
              (r) =>
                event.clientX >= r.left &&
                event.clientX <= r.right &&
                event.clientY >= r.top &&
                event.clientY <= r.bottom,
            ),
          )
          event.currentTarget.title =
            hit?.getAttribute('data-warning') ??
            (hit && onLocate ? '⌘ / Ctrl + 点击定位引用元素' : '')
        }}
        onScroll={(event) => {
          sync()
          onScroll?.(event)
        }}
      />
      <div
        ref={layer}
        aria-hidden="true"
        className="plein-mention-layer"
        data-testid="mention-highlights"
      >
        <div ref={content}>
          {mentionParts(value, targets).map((part) =>
            part.mention ? (
              <mark
                key={part.start}
                className="plein-mention"
                data-state={part.missing ? 'missing' : part.warning ? 'warning' : 'resolved'}
                data-mention-id={part.id}
                data-warning={part.warning}
              >
                {part.text}
              </mark>
            ) : (
              part.text
            ),
          )}
          {'\n'}
        </div>
      </div>
    </div>
  )
}
