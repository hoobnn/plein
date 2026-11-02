import { m } from 'motion/react'
import type { ReactNode } from 'react'
import { toastVariants, useOverlayMotion } from './motion'

/** 顶栏下方居中的提示条；包在 `<AnimatePresence>` 里，消失时往上收回 */
export function Toast({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-toast-wrap pointer-events-none">
      <m.div
        role="status"
        className={
          action ? 'ui-toast ui-motion ui-toast-action pointer-events-auto' : 'ui-toast ui-motion'
        }
        {...useOverlayMotion(toastVariants)}
      >
        {children}
        {action}
      </m.div>
    </div>
  )
}
