import { LazyMotion as MotionFeatures } from 'motion/react'
import type { ReactNode } from 'react'

/** 独立异步入口：首屏只保留 MotionConfig，m 的渲染核心随此宿主加载。 */
export function LazyMotion({ children }: { children: ReactNode }) {
  return (
    <MotionFeatures
      strict
      features={() => import('./motion-features').then((module) => module.default)}
    >
      {children}
    </MotionFeatures>
  )
}
