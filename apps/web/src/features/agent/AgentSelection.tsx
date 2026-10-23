import { useState, useSyncExternalStore } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { useAgent } from './store'

/** 对话中的真实画布目标；删除目标仍保留原 ID，不能误定位到同名新元素。 */
export function AgentSelection({
  ids,
  canvasId,
  signature,
}: {
  ids: string[]
  canvasId?: string
  signature?: string
}) {
  const engine = useCanvas((s) => s.engine)
  const [expanded, setExpanded] = useState(false)
  const snapshot = useSyncExternalStore(
    (notify) =>
      engine?.doc.subscribe((change) => {
        if (ids.some((id) => change.elements.has(id))) notify()
      }) ?? (() => {}),
    () =>
      JSON.stringify(
        ids.map((id) => {
          const element = engine?.doc.get(id)
          return {
            id,
            name: element?.name || element?.nodeType || element?.kind || id,
            missing: !element,
          }
        }),
      ),
  )
  const targets = JSON.parse(snapshot) as Array<{ id: string; name: string; missing: boolean }>
  if (!ids.length) return null
  return (
    <div
      className="flex flex-wrap gap-1"
      aria-label={canvasId ? '本轮画布目标' : '消息附带的画布目标'}
    >
      {(expanded ? targets : targets.slice(0, 6)).map((target) => (
        <span key={target.id} className="ui-chip max-w-full gap-0.5 pr-0.5">
          <button
            type="button"
            title={target.id}
            aria-label={`${target.missing ? '已删除元素' : '定位元素'}：${target.name}`}
            disabled={target.missing}
            className="min-w-0 truncate px-0.5 text-left"
            onClick={() => engine?.flyTo([target.id])}
          >
            {target.missing ? `已删除 · ${target.name}` : target.name}
          </button>
          {canvasId && signature && (
            <button
              type="button"
              className="ui-chip-remove"
              aria-label={`不带元素：${target.name}`}
              title="从本轮上下文移除"
              onClick={() => useAgent.getState().excludeTarget(canvasId, signature, target.id)}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
      {targets.length > 6 && (
        <button
          type="button"
          className="ui-btn ui-btn-xs ui-btn-quiet"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起目标' : `另 ${targets.length - 6} 个元素`}
        </button>
      )}
    </div>
  )
}
