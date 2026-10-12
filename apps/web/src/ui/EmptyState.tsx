import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'

/**
 * 空状态：列表、面板、对话框里“还没有内容”或“没有符合筛选”的统一样子。
 * 24 的类型图标（可省）、一行标题、一段说明、一个操作按钮；fill 时铺满父容器、上下居中。
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  fill = false,
  compact = false,
}: {
  icon?: IconName
  title: ReactNode
  hint?: ReactNode
  action?: ReactNode
  /** 铺满父容器（父容器是 flex 列或有固定高度）并上下居中 */
  fill?: boolean
  /** 侧栏、弹层这类窄处：上下留白小一些，标题用小号字 */
  compact?: boolean
}) {
  return (
    <div className={`ui-empty ${fill ? 'ui-empty-fill' : ''} ${compact ? 'ui-empty-compact' : ''}`}>
      {icon && <Icon name={icon} size={24} />}
      <p className="ui-empty-title">{title}</p>
      {hint && <p className="ui-empty-hint">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
