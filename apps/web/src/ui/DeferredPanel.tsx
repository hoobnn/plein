import { type ReactNode, Suspense, useState } from 'react'

/** 第一次打开才加载；之后保留宿主，让浮层自己的 AnimatePresence 完成退场。 */
export function DeferredPanel({
  active,
  fallback = null,
  children,
}: {
  active: boolean
  fallback?: ReactNode
  children: ReactNode
}) {
  const [opened, setOpened] = useState(active)
  if (active && !opened) setOpened(true)
  return active || opened ? <Suspense fallback={fallback}>{children}</Suspense> : null
}
