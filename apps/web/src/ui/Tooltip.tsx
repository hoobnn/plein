import { Tooltip as Base } from '@base-ui/react/tooltip'
import { useCallback, useEffect, useRef, useState } from 'react'

interface ActiveTitle {
  element: HTMLElement
  text: string
}

const TRIGGER_ID = 'plein-global-title-tooltip'

function pointerEvent(type: string, relatedTarget?: EventTarget | null) {
  return new PointerEvent(type, {
    bubbles: true,
    pointerType: 'mouse',
    relatedTarget: relatedTarget as EventTarget | null,
  })
}

function mouseEvent(type: string, relatedTarget?: EventTarget | null) {
  return new MouseEvent(type, {
    bubbles: true,
    relatedTarget: relatedTarget as EventTarget | null,
  })
}

/**
 * 全局悬停提示：接管页面上所有 `title` 属性，换成与应用一致的提示气泡，不再弹系统原生的黄色小框。
 * 指针移入时把 title 暂存到 data-tip 并留空占位，移出时还原；悬停期间同步 React 对 title 的更新。
 * Base UI 负责延迟、相邻提示接力、定位与碰撞翻转。
 */
export function TooltipHost() {
  const [handle] = useState(() => Base.createHandle())
  const [current, setCurrent] = useState<ActiveTitle | null>(null)
  const currentRef = useRef(current)
  currentRef.current = current
  const trigger = useRef<HTMLElement>(null)
  const forwarded = useRef<HTMLElement | null>(null)
  const hide = useCallback(() => {
    if (handle.isOpen) handle.close()
    setCurrent(null)
  }, [handle])

  const overTrigger = useCallback((relatedTarget?: EventTarget | null) => {
    const element = trigger.current
    if (!element) return
    element.dispatchEvent(pointerEvent('pointerenter', relatedTarget))
    element.dispatchEvent(pointerEvent('pointerover', relatedTarget))
    element.dispatchEvent(mouseEvent('mouseenter', relatedTarget))
    element.dispatchEvent(mouseEvent('mouseover', relatedTarget))
    element.dispatchEvent(mouseEvent('mousemove', relatedTarget))
  }, [])
  const outTrigger = useCallback((relatedTarget?: EventTarget | null) => {
    const element = trigger.current
    if (!element) return
    element.dispatchEvent(pointerEvent('pointerleave', relatedTarget))
    element.dispatchEvent(mouseEvent('mouseleave', relatedTarget))
    element.dispatchEvent(pointerEvent('pointerout', relatedTarget))
    element.dispatchEvent(mouseEvent('mouseout', relatedTarget))
  }, [])

  // 新目标先由 Base UI Trigger 接管指针序列；首延迟和相邻目标的即时接力都由它决定。
  useEffect(() => {
    const element = current?.element
    if (!element) return
    if (forwarded.current === element) {
      forwarded.current = null
      return
    }
    queueMicrotask(() => {
      if (currentRef.current?.element === element) overTrigger(element)
    })
  }, [current?.element, overTrigger])

  // title 接管只处理属性与无障碍名称，不再计算气泡位置或管理计时器。
  useEffect(() => {
    const element = current?.element
    if (!element) return
    const initialText = currentRef.current?.text ?? ''
    let automaticLabel: string | undefined
    const syncLabel = (text: string) => {
      if (
        (!element.hasAttribute('aria-label') && !element.textContent?.trim()) ||
        automaticLabel === element.getAttribute('aria-label')
      ) {
        element.setAttribute('aria-label', text)
        automaticLabel = text
      }
    }
    element.dataset.tip = element.getAttribute('title') ?? initialText
    element.setAttribute('title', '')
    syncLabel(initialText)

    const observer = new MutationObserver((records) => {
      if (currentRef.current?.element !== element) return
      if (!element.isConnected) return hide()
      if (!records.some((record) => record.target === element && record.attributeName === 'title'))
        return
      const latest = element.getAttribute('title') ?? ''
      if (!latest.trim()) {
        delete element.dataset.tip
        hide()
        return
      }
      const text = latest.trim()
      if (automaticLabel === element.getAttribute('aria-label')) syncLabel(text)
      element.dataset.tip = latest
      observer.disconnect()
      element.setAttribute('title', '')
      observer.observe(element, { attributes: true, attributeFilter: ['title'] })
      observer.observe(document.body, { childList: true, subtree: true })
      setCurrent((active) => (active?.element === element ? { ...active, text } : active))
    })
    observer.observe(element, { attributes: true, attributeFilter: ['title'] })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      const changed = observer
        .takeRecords()
        .some((record) => record.target === element && record.attributeName === 'title')
      observer.disconnect()
      if (element.dataset.tip !== undefined) {
        if (!changed && element.getAttribute('title') === '')
          element.setAttribute('title', element.dataset.tip)
        delete element.dataset.tip
      }
      if (automaticLabel !== undefined && element.getAttribute('aria-label') === automaticLabel)
        element.removeAttribute('aria-label')
    }
  }, [current?.element, hide])

  useEffect(() => {
    const over = (event: PointerEvent) => {
      if (event.target === trigger.current || event.pointerType === 'touch') return
      const active = currentRef.current
      if (active?.element.contains(event.target as Node)) {
        overTrigger(event.relatedTarget)
        return
      }
      if (active) outTrigger(event.relatedTarget)
      const element = (event.target as Element | null)?.closest?.<HTMLElement>('[title]')
      const text = element?.getAttribute('title')?.trim()
      if (!element || !text) return hide()
      if (active) {
        forwarded.current = element
        overTrigger(event.relatedTarget)
      }
      setCurrent({ element, text })
    }
    const out = (event: PointerEvent) => {
      if (event.target === trigger.current) return
      const active = currentRef.current
      if (!active) return
      const next = event.relatedTarget as Node | null
      if (next && active.element.contains(next)) return
      outTrigger(next)
    }
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('wheel', hide, { capture: true })
      window.removeEventListener('blur', hide)
    }
  }, [hide, outTrigger, overTrigger])

  return (
    <Base.Provider delay={450} closeDelay={150} timeout={400}>
      <Base.Root handle={handle} onOpenChange={(open) => !open && setCurrent(null)}>
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
