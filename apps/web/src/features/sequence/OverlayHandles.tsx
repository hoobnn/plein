import type { ComposeOverlay } from '@plein/plugin-sdk'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useClosing } from '../../ui/Presence'
import type { Playhead } from './playhead'
export type OverlayGeometry = Pick<ComposeOverlay, 'x' | 'y' | 'width' | 'height'>
export function OverlayHandles({
  overlays,
  playhead,
  selected,
  readOnly,
  onSelect,
  onDraft,
  onCommit,
}: {
  overlays: ComposeOverlay[]
  playhead: Playhead
  selected?: string
  readOnly: boolean
  onSelect(id: string): void
  onDraft(value: { id: string; patch: OverlayGeometry } | null): void
  onCommit(id: string, patch: OverlayGeometry): void
}) {
  const closing = useClosing()
  const activeKey = useSyncExternalStore(playhead.subscribe, () =>
    overlays
      .filter(
        (overlay) => playhead.t >= overlay.start && playhead.t < overlay.start + overlay.duration,
      )
      .map((overlay) => overlay.id)
      .join('|'),
  )
  const pending = useRef<AbortController | null>(null)
  const key = JSON.stringify(overlays)
  useEffect(
    () => () => {
      pending.current?.abort()
      onDraft(null)
    },
    [key, readOnly, closing, onDraft],
  )
  return (
    <div className="pointer-events-none absolute inset-0 z-10" aria-label="叠加图层画面操作">
      {overlays
        .filter((overlay) => activeKey.split('|').includes(overlay.id))
        .map((overlay, index) => (
          <button
            key={overlay.id}
            type="button"
            aria-label={`选择叠加图层 ${index + 1}`}
            title={readOnly ? '叠加图层（只读）' : '拖动图层；右下角调整大小'}
            className={`pointer-events-auto absolute bg-transparent ${selected === overlay.id ? 'border-2 border-dashed border-accent' : 'border border-transparent hover:border-white/50'}`}
            style={{
              left: `${overlay.x * 100}%`,
              top: `${overlay.y * 100}%`,
              width: `${overlay.width * 100}%`,
              height: `${overlay.height * 100}%`,
            }}
            onClick={() => onSelect(overlay.id)}
            onPointerDown={(event) => {
              if (event.button !== 0 || readOnly || closing) return
              event.preventDefault()
              onSelect(overlay.id)
              playhead.pause()
              pending.current?.abort()
              const controller = new AbortController()
              pending.current = controller
              const rect = event.currentTarget.parentElement!.getBoundingClientRect(),
                x = event.clientX,
                y = event.clientY
              const resize =
                event.target instanceof Element && !!event.target.closest('[data-resize]')
              let patch: OverlayGeometry = {
                x: overlay.x,
                y: overlay.y,
                width: overlay.width,
                height: overlay.height,
              }
              const move = (next: PointerEvent) => {
                if (next.pointerId !== event.pointerId) return
                const dx = (next.clientX - x) / rect.width,
                  dy = (next.clientY - y) / rect.height
                patch = resize
                  ? {
                      ...patch,
                      width: Math.min(1, Math.max(0.001, overlay.width + dx)),
                      height: Math.min(1, Math.max(0.001, overlay.height + dy)),
                    }
                  : {
                      ...patch,
                      x: Math.min(1, Math.max(0, overlay.x + dx)),
                      y: Math.min(1, Math.max(0, overlay.y + dy)),
                    }
                onDraft({ id: overlay.id, patch })
              }
              window.addEventListener('pointermove', move, { signal: controller.signal })
              window.addEventListener(
                'pointerup',
                (next) => {
                  if (next.pointerId !== event.pointerId) return
                  controller.abort()
                  onDraft(null)
                  onCommit(overlay.id, patch)
                },
                { signal: controller.signal },
              )
              window.addEventListener(
                'pointercancel',
                (next) => {
                  if (next.pointerId !== event.pointerId) return
                  controller.abort()
                  onDraft(null)
                },
                { signal: controller.signal },
              )
              window.addEventListener(
                'blur',
                () => {
                  controller.abort()
                  onDraft(null)
                },
                { signal: controller.signal },
              )
            }}
          >
            {selected === overlay.id && (
              <span
                data-resize
                className="absolute -right-1 -bottom-1 size-3 cursor-se-resize rounded border border-white bg-accent"
              />
            )}
          </button>
        ))}
    </div>
  )
}
