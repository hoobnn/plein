import { Tooltip as Base } from '@base-ui/react/tooltip'
import { useEffect, useState, type RefObject } from 'react'
import type { ActiveTitle } from './Tooltip'

const TRIGGER_ID = 'plein-global-title-tooltip'

/** 首次有效悬停才加载的气泡层；全局 title 接管留在轻量宿主里。 */
export function TooltipBubble({
  current,
  trigger,
  closeRef,
  onReady,
  onClose,
}: {
  current: ActiveTitle | null
  trigger: RefObject<HTMLElement | null>
  closeRef: RefObject<(() => void) | null>
  onReady(): void
  onClose(): void
}) {
  const [handle] = useState(() => Base.createHandle())
  useEffect(() => {
    closeRef.current = () => {
      if (handle.isOpen) handle.close()
    }
    onReady()
    return () => {
      closeRef.current = null
      trigger.current = null
    }
  }, [handle, closeRef, trigger, onReady])

  return (
    <Base.Provider delay={450} closeDelay={150} timeout={400}>
      <Base.Root handle={handle} onOpenChange={(open) => !open && onClose()}>
        <Base.Trigger
          ref={(element: HTMLButtonElement | null) => {
            trigger.current = element
          }}
          id={TRIGGER_ID}
          handle={handle}
          render={<span hidden aria-hidden="true" />}
        />
        {current && (
          <Base.Portal>
            <Base.Positioner
              anchor={current.element}
              side="bottom"
              align="center"
              sideOffset={6}
              collisionPadding={8}
              className="isolate z-80"
            >
              <Base.Popup
                role="tooltip"
                className="ui-tooltip pointer-events-none inline-flex max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs break-words text-on-primary shadow-none"
              >
                {current.text}
              </Base.Popup>
            </Base.Positioner>
          </Base.Portal>
        )}
      </Base.Root>
    </Base.Provider>
  )
}
