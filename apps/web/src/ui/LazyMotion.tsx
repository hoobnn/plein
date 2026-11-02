import { LazyMotion as MotionFeatures, MotionConfig, type FeatureBundle } from 'motion/react'
import { createContext, type ReactNode, useState } from 'react'

/** 特性加载失败时，useOverlayMotion 切换为可见的无动画展示。 */
export const MotionFeatureFailure = createContext(false)

export function loadMotionFeatures(): Promise<FeatureBundle> {
  return import('./motion-features').then((module) => module.default)
}

/** 独立异步入口：首屏只保留 MotionConfig，m 的渲染核心随此宿主加载。 */
export function LazyMotion({ children }: { children: ReactNode }) {
  const [failed, setFailed] = useState(false)
  return (
    <MotionFeatureFailure.Provider value={failed}>
      <MotionConfig skipAnimations={failed}>
        <MotionFeatures
          strict
          features={() =>
            loadMotionFeatures().catch(() => {
              setFailed(true)
              // 空特性包只用于结束 LazyMotion 的等待；可见性降级由 context 完成。
              return {} as FeatureBundle
            })
          }
        >
          {children}
        </MotionFeatures>
      </MotionConfig>
    </MotionFeatureFailure.Provider>
  )
}
