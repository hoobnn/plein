import type { Page } from '@playwright/test'

/** 合并相邻步骤只改变派发节奏，保留事件数量、顺序、位移与缩放路径。 */
export function dispatchWheel(
  page: Page,
  opts: { frames: number; perFrame: number; zoom: boolean; stepsPerFrame?: number },
) {
  return page.evaluate(
    ({ frames, perFrame, zoom, stepsPerFrame = 1 }) =>
      new Promise<void>((done) => {
        const host = document.querySelector('canvas')!.parentElement!
        const r = host.getBoundingClientRect()
        let i = 0
        const step = () => {
          const end = Math.min(i + stepsPerFrame, frames)
          for (; i < end; i++) {
            for (let k = 0; k < perFrame; k++) {
              const phase = Math.sin((i / frames) * Math.PI * 2)
              host.dispatchEvent(
                new WheelEvent('wheel', {
                  bubbles: true,
                  cancelable: true,
                  clientX: r.left + r.width / 2,
                  clientY: r.top + r.height / 2,
                  deltaX: zoom ? 0 : 6 * phase,
                  deltaY: zoom ? 3 * phase : 4,
                  ctrlKey: zoom,
                }),
              )
            }
          }
          if (i < frames) requestAnimationFrame(step)
          else requestAnimationFrame(() => done())
        }
        requestAnimationFrame(step)
      }),
    opts,
  )
}
