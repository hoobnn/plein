import type { ReactNode } from 'react'
import { useExit } from './Presence'

/** 顶栏下方居中的提示条；包在 `<Presence>` 里，消失时往上收回 */
export function Toast({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex justify-center px-4">
      <div role="status" className="ui-toast" {...useExit()}>
        {children}
      </div>
    </div>
  )
}
