import type { Menu } from '@base-ui/react/menu'
import { type ComponentProps, type PointerEvent, useEffect, useRef, useState } from 'react'

/** 菜单与窗口协调：让位于上层窗口，并取消尚未完成的触发器点击。 */
export function useDialogMenu() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const cancelledAt = useRef(-Infinity)
  const owner = () => trigger.current?.closest('[role="dialog"]')
  const otherDialogFocused = () => {
    const active = document.activeElement?.closest('[role="dialog"]')
    return !!active && active !== owner()
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        event.isComposing ||
        event.keyCode === 229 ||
        !pending.current ||
        !(event.target instanceof Node) ||
        !trigger.current?.contains(event.target)
      )
        return
      pending.current = false
      cancelledAt.current = event.timeStamp
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [])

  useEffect(() => {
    if (!open) return
    const focus = () => {
      if (otherDialogFocused()) setOpen(false)
    }
    document.addEventListener('focusin', focus)
    focus()
    return () => document.removeEventListener('focusin', focus)
  }, [open])

  const onOpenChange: NonNullable<ComponentProps<typeof Menu.Root>['onOpenChange']> = (
    next,
    details,
  ) => {
    pending.current = false
    if (next && (details.event.timeStamp <= cancelledAt.current || otherDialogFocused())) {
      details.cancel()
      return
    }
    if (!next && details.reason === 'escape-key') {
      // 原菜单可能已经卸载；同一个原生 Esc 不能再交给外层对话框。
      details.event.preventDefault()
      details.event.stopPropagation()
    }
    setOpen(next)
  }

  return {
    open,
    onOpenChange,
    triggerProps: {
      ref: trigger,
      onPointerDownCapture: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button === 0) pending.current = true
      },
      onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => {
        pending.current = false
        cancelledAt.current = event.timeStamp
        setOpen(false)
      },
    },
  }
}
