import { LazyMotion as MotionFeatures, MotionConfig, type FeatureBundle } from 'motion/react'
import { createContext, type ReactNode, useState } from 'react'

/** 特性加载失败时，useOverlayMotion 切换为可见的无动画展示。 */
export const MotionFeatureFailure = createContext(false)

/**
 * 有没有 Motion 宿主。m 组件只有在宿主下面才拿得到渲染器；没有宿主时它不会执行
 * animate，只会把初始变体的 opacity 0 画上去，整块浮层看不见却还挡着交互。
 */
export const MotionHost = createContext(false)

export function loadMotionFeatures(): Promise<FeatureBundle> {
  return import('./motion-features').then((module) => module.default)
}

/** 独立异步入口：首屏只保留 MotionConfig，m 的渲染核心随此宿主加载。 */
export function LazyMotion({ children }: { children: ReactNode }) {
  const [failed, setFailed] = useState(false)
  return (
    <MotionHost.Provider value>
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
    </MotionHost.Provider>
  )
}
