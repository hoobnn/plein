import { MotionConfig } from 'motion/react'
import { type ReactNode, useEffect } from 'react'
import { prefetchIdle } from './idle'

/** App 立即渲染；浮层运行时只在空闲时预取，不包住应用的加载过程。 */
export function MotionProvider({ children }: { children: ReactNode }) {
  useEffect(() => prefetchIdle([() => import('./motion')]), [])
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
