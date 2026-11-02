import { MotionConfig } from 'motion/react'
import { lazy, type ReactNode, Suspense } from 'react'

const LazyMotion = lazy(() =>
  import('./LazyMotion').then((module) => ({ default: module.LazyMotion })),
)

/** reducedMotion 配置留在根部；LazyMotion 与动画实现延后加载，不阻塞打开请求。 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <Suspense fallback={null}>
        <LazyMotion>{children}</LazyMotion>
      </Suspense>
    </MotionConfig>
  )
}
