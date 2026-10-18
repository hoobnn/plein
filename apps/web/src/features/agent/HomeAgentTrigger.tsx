import { Mascot } from '../../ui/Mascot'
import { useAgent } from './store'

/** 首页入口随工具栏布局，避免悬浮开关遮挡可滚动的项目卡片。 */
export function HomeAgentTrigger() {
  const open = useAgent((s) => s.open)
  const mood = useAgent((s) => s.mood)
  const unread = useAgent((s) => s.unread)
  return (
    <button
      type="button"
      data-agent-trigger
      aria-label={open ? '收起助手' : '打开助手'}
      aria-expanded={open}
      title="小满：让本机的 Claude Code / Codex 帮你操作画布"
      className="ui-bar-btn relative"
      onClick={() => useAgent.getState().toggle()}
    >
      <Mascot mood={mood} size={26} />
      {unread && (
        <span
          role="img"
          aria-label="助手有新回复"
          className="absolute top-1 right-1 size-2 rounded-full bg-accent ring-2 ring-canvas"
        />
      )}
    </button>
  )
}
