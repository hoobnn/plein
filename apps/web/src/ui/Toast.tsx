import type { ReactNode } from 'react'
import { useExit } from './Presence'

/** 顶栏下方居中的提示条；包在 `<Presence>` 里，消失时往上收回 */
export function Toast({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-toast-wrap pointer-events-none">
      <div
        role="status"
        className={action ? 'ui-toast ui-toast-action pointer-events-auto' : 'ui-toast'}
        {...useExit()}
      >
        {children}
        {action}
      </div>
    </div>
  )
}
