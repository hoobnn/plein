import { useState } from 'react'
import { MOD } from '../ui/keys'
import { Icon } from '../ui/icons'
import { dismissShortcutHint, shouldShowShortcutHint } from './hintStorage'

/** 首次进入画布时一条轻量的快捷键提示，贴在顶部居中，关闭后不再出现 */
export function ShortcutHint() {
  const [visible, setVisible] = useState(shouldShowShortcutHint)
  if (!visible) return null
  return (
    <div
      role="note"
      aria-label="画布快捷操作提示"
      className="ui-float pointer-events-auto fixed top-14 left-1/2 z-20 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-xs text-ink-muted max-sm:hidden"
    >
      <span className="min-w-0 truncate">
        右键拖动平移 · <span className="ui-keycap">Tab</span> 添加节点 ·{' '}
        <span className="ui-keycap">{MOD} K</span> 命令面板 · <span className="ui-keycap">?</span>{' '}
        全部快捷键
      </span>
      <button
        type="button"
        className="ui-btn ui-btn-ghost ui-btn-sm ui-icon-btn"
        aria-label="关闭快捷键提示"
        onClick={() => {
          dismissShortcutHint()
          setVisible(false)
        }}
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}
