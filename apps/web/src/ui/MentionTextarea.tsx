import type { MentionTarget } from '@plein/nodes'
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithRef,
} from 'react'
import { mentionParts, type MentionReferences } from '../canvas/mentionText'

/** 文件名去掉常见扩展名，只影响显示，不改原文与引用位置。 */
function referenceDisplayName(name: string) {
  return name.replace(
    /\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|mp4|m4v|mov|webm|mkv|avi|wav|mp3|m4a|aac|flac|ogg)$/i,
    '',
  )
}

/** 保留原生 textarea 的输入、选择、IME 与复制行为，镜像层显示正文和引用颜色。 */
export function MentionTextarea({
  ref,
  value,
  targets,
  references,
  onScroll,
  onClick,
  onPointerMove,
  onLocate,
  ...props
}: Omit<ComponentPropsWithRef<'textarea'>, 'value'> & {
  value: string
  targets: readonly MentionTarget[]
  references?: MentionReferences
  onLocate?(id: string): void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => input.current!)
  /**
   * 引用跨行时，绝对定位容器的 100% 宽度会变成 0；按原文第一行的实际宽度显式设置，
   * 让徽标后的名称至少在第一行余量里显示并按需省略。只改叠加层，不影响 textarea 排版。
   */
  const fitTags = useCallback(() => {
    const body = content.current
    if (!body) return
    for (const tags of body.querySelectorAll<HTMLElement>('.plein-mention-tags')) {
      const raw = tags.parentElement?.querySelector<HTMLElement>('.plein-mention-raw')
      const first = raw?.getClientRects()[0]
      tags.style.width = first ? `${first.width}px` : ''
    }
  }, [])
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
    fitTags()
  }, [fitTags])
  useLayoutEffect(sync)
  useLayoutEffect(fitTags)
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
          const part = mentionParts(value, targets, references).find(
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
            // 短名字的编号徽标会伸出原文占位宽度，悬停徽标本身也要能读到名称。
            [
              ...mark.getClientRects(),
              ...(mark.querySelector('.plein-mention-badge')?.getClientRects() ?? []),
            ].some(
              (r) =>
                event.clientX >= r.left &&
                event.clientX <= r.right &&
                event.clientY >= r.top &&
                event.clientY <= r.bottom,
            ),
          )
          event.currentTarget.title =
            hit?.getAttribute('data-warning') ??
            hit?.getAttribute('data-title') ??
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
          {mentionParts(value, targets, references).map((part) =>
            part.mention ? (
              <mark
                key={part.start}
                className="plein-mention"
                data-state={part.missing ? 'missing' : part.warning ? 'warning' : 'resolved'}
                data-mention-id={part.id}
                data-warning={part.warning}
                data-title={part.badge?.title}
                title={part.badge?.title ?? part.warning}
              >
                {part.badge ? (
                  <>
                    {/* 原文保留占位宽度，徽标与名称叠在上面，正文不会跟着挪位 */}
                    <span className="plein-mention-raw">{part.text}</span>
                    <span className="plein-mention-tags">
                      <span className="plein-mention-badge">
                        {part.badge.labels.length > 1
                          ? `${part.badge.labels[0]}+${part.badge.labels.length - 1}`
                          : part.badge.labels[0]}
                      </span>
                      {part.badge.name && (
                        <span className="plein-mention-name">
                          {referenceDisplayName(part.badge.name)}
                        </span>
                      )}
                    </span>
                  </>
                ) : (
                  part.text
                )}
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
