import type { ArrangeResult, Engine } from '@plein/canvas-core'
import { m } from 'motion/react'
import { useEffect, useState } from 'react'
import { useEngineVersion, useFollow } from '../canvas/hooks'
import { canvasBottomSpace } from '../canvas/floatingPanel'
import { useCanvas } from '../stores/canvas'
import { Icon } from '../ui/icons'
import { AnimatePresence, popUpVariants, useOverlayMotion } from '../ui/motion'

/** 整理后多久自动收起（视为保留） */
const AUTO_HIDE_MS = 10_000

/**
 * 整理完成后报告结果并提供还原入口。
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
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!arranged) {
      setHovered(false)
      setFocused(false)
    }
  }, [arranged])
  const place = () => ({
    bottom: canvasBottomSpace(window.innerWidth, engine.camera.insets.left).generator + 8,
  })
  const ref = useFollow<HTMLDivElement>(engine, place)

  useEffect(() => {
    // 过期后彻底丢弃，不能在撤销后续编辑、原整理重新回到栈顶时复活旧提示。
    if (arranged?.stale()) setArranged(null)
  }, [arranged, setArranged, version])

  useEffect(() => {
    // 用户正在读提示、选择按钮或等待恢复写权限时，不自动收走还原入口。
    if (!arranged || hovered || focused || engine.doc.readOnly) return
    const t = setTimeout(() => setArranged(null), AUTO_HIDE_MS)
    return () => clearTimeout(t)
  }, [arranged, setArranged, hovered, focused, engine.doc.readOnly])

  return (
    <AnimatePresence>
      {arranged && !arranged.stale() && (
        <div
          ref={ref}
          style={place()}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
          }}
          className="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
        >
          <Bar
            arranged={arranged}
            readOnly={engine.doc.readOnly}
            onDone={() => setArranged(null)}
          />
        </div>
      )}
    </AnimatePresence>
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
    <m.div
      role="status"
      {...useOverlayMotion(popUpVariants)}
      className="ui-bar ui-bar-sm ui-pop ui-pop-up ui-motion pointer-events-auto gap-3 pr-1.5 pl-4"
    >
      {/* 与带操作的提示条共用 40 高、28 按钮、12 间距；文字折行时自然增高 */}
      <span className="min-w-0">
        {readOnly ? '当前只读，暂时无法还原' : `已整理 ${arranged.count} 个元素`}
      </span>
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
        <button
          type="button"
          aria-label="关闭整理提示"
          title="关闭整理提示"
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          onClick={onDone}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </m.div>
  )
}
