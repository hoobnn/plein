import { LazyMotion, MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/** 动画核心随首屏加载，DOM 动画特性在第一个 m 组件需要时异步加载。 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion
      strict
      features={() => import('./motion-features').then((module) => module.default)}
    >
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  )
}
