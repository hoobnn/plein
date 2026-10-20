import type { ArrangeResult, Engine } from '@plein/canvas-core'
import { useEffect } from 'react'
import { useEngineVersion, useFollow } from '../canvas/hooks'
import { canvasBottomSpace } from '../canvas/floatingPanel'
import { useCanvas } from '../stores/canvas'
import { Presence, useExit } from '../ui/Presence'

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
  const version = useEngineVersion(engine)
  const arranged = useCanvas((s) => s.arranged)
  const setArranged = useCanvas((s) => s.setArranged)
  const place = () => ({
    bottom: canvasBottomSpace(window.innerWidth, engine.camera.insets.left).generator + 8,
  })
  const ref = useFollow<HTMLDivElement>(engine, place)

  useEffect(() => {
    // 过期后彻底丢弃，不能在撤销后续编辑、原整理重新回到栈顶时复活旧提示。
    if (arranged?.stale()) setArranged(null)
  }, [arranged, setArranged, version])

  useEffect(() => {
    if (!arranged) return
    const t = setTimeout(() => setArranged(null), AUTO_HIDE_MS)
    return () => clearTimeout(t)
  }, [arranged, setArranged])

  return (
    <Presence>
      {arranged && !arranged.stale() && (
        <div
          ref={ref}
          style={place()}
          className="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
        >
          <Bar
            arranged={arranged}
            readOnly={engine.doc.readOnly}
            onDone={() => setArranged(null)}
          />
        </div>
      )}
    </Presence>
  )
}

function Bar({
  arranged,
  readOnly,
  onDone,
}: {
  arranged: ArrangeResult
  readOnly: boolean
  onDone(): void
}) {
  return (
    <div
      role="status"
      {...useExit()}
      className="ui-bar ui-bar-sm ui-pop ui-pop-up pointer-events-auto gap-3 pr-1.5 pl-4"
    >
      <span>{readOnly ? '当前只读，暂时无法还原' : '是否保留此次整理结果？'}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={readOnly}
          onClick={() => {
            arranged.revert()
            onDone()
          }}
        >
          还原
        </button>
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={onDone}>
          保留
        </button>
      </div>
    </div>
  )
}
