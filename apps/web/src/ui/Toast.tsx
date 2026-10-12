import type { ReactNode } from 'react'
import { useExit } from './Presence'

/** 顶栏下方居中的提示条；包在 `<Presence>` 里，消失时往上收回 */
export function Toast({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex justify-center px-4">
      <div
        role="status"
        className={action ? 'ui-toast pointer-events-auto gap-3 pr-2' : 'ui-toast'}
        {...useExit()}
      >
        {children}
        {action}
      </div>
    </div>
  )
}
