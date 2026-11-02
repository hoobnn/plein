import type { ReactNode } from 'react'

/** 浮层模块加载或失败期间承接提示；与 Toast 同构但不加载 Motion。 */
export function StaticToast({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-toast-wrap pointer-events-none">
      <div
        role="status"
        className={
          action ? 'ui-toast ui-motion ui-toast-action pointer-events-auto' : 'ui-toast ui-motion'
        }
      >
        {children}
        {action}
      </div>
    </div>
  )
}
