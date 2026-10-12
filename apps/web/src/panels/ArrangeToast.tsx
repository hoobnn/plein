import type { Engine } from '@plein/canvas-core'
import { useEffect } from 'react'
import { useEngineVersion } from '../canvas/hooks'
import { useCanvas } from '../stores/canvas'

/** 整理后多久自动收起（视为保留） */
const AUTO_HIDE_MS = 10_000

/**
 * 整理画布后在底部询问是否保留：还原即撤销这一步。
 * 撤销、重做或之后又有修改时，这一步已不在栈顶，提示自动收起。
 */
export function ArrangeToast() {
  const engine = useCanvas((s) => s.engine)
  if (!engine) return null
  return <ArrangeToastHost engine={engine} />
}

function ArrangeToastHost({ engine }: { engine: Engine }) {
  // 文档每次变化都重新检查是否过期
  useEngineVersion(engine)
  const arranged = useCanvas((s) => s.arranged)
  const setArranged = useCanvas((s) => s.setArranged)

  useEffect(() => {
    if (!arranged) return
    const t = setTimeout(() => setArranged(null), AUTO_HIDE_MS)
    return () => clearTimeout(t)
  }, [arranged, setArranged])

  if (!arranged || arranged.stale()) return null

  return (
    <div
      role="status"
      className="ui-bar ui-bar-sm pointer-events-auto absolute bottom-16 left-1/2 z-30 -translate-x-1/2 gap-3 pr-1.5 pl-4"
    >
      <span>是否保留此次整理结果？</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          onClick={() => {
            arranged.revert()
            setArranged(null)
          }}
        >
          还原
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-primary ui-btn-sm"
          onClick={() => setArranged(null)}
        >
          保留
        </button>
      </div>
    </div>
  )
}
