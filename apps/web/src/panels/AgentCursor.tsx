import { type Engine, union } from '@plein/canvas-core'
import { useEffect, useRef, useState } from 'react'
import { useAgent } from '../stores/agent'
import { useCanvas } from '../stores/canvas'
import { Mascot } from '../ui/Mascot'

/** 光标飘到下一个元素的时长 */
const GLIDE_MS = 520
/** 最后一次改动后停留多久再淡出 */
const LINGER_MS = 2400
/** 新元素可能还没同步到画布：最多等这么久 */
const WAIT_MS = 3000

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const ease = (t: number) => 1 - (1 - t) ** 3

/** 光标指向元素左上部：落在卡片里，不挡标题 */
function targetOf(engine: Engine, ids: string[]) {
  const box = union(ids.map((id) => engine.scene.rect(id)).filter((r) => !!r))
  if (!box) return null
  return { x: box.x + Math.min(box.w * 0.3, 64), y: box.y + Math.min(box.h * 0.3, 48) }
}

/**
 * 小满的光标：智能体改动画布时，一个带小满头像的指针飘到刚改过的元素上，
 * 让人看得出改动从哪来、发生在哪。坐标记在世界坐标里，平移缩放时跟着画布走。
 */
export function AgentCursor() {
  const engine = useCanvas((s) => s.engine)
  const cursor = useAgent((s) => s.cursor)
  if (!engine || !cursor) return null
  return <Cursor engine={engine} cursor={cursor} />
}

function Cursor({ engine, cursor }: { engine: Engine; cursor: { ids: string[]; at: number } }) {
  const ref = useRef<HTMLDivElement>(null)
  /** 当前所在的世界坐标；飘的过程中每帧更新 */
  const pos = useRef<{ x: number; y: number } | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let frame = 0
    let flight: { from: { x: number; y: number }; to: { x: number; y: number }; start: number }
    let hide = 0
    const started = performance.now()
    const draw = () => {
      const node = ref.current
      if (!node || !pos.current) return
      const p = engine.worldToClient(pos.current.x, pos.current.y)
      node.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`
    }
    const tick = (now: number) => {
      if (!flight) {
        const to = targetOf(engine, cursor.ids)
        if (!to) {
          if (now - started < WAIT_MS) frame = requestAnimationFrame(tick)
          return
        }
        flight = { from: pos.current ?? to, to, start: now }
        setVisible(true)
        hide = window.setTimeout(() => setVisible(false), LINGER_MS)
      }
      const t = reduced() ? 1 : Math.min(1, (now - flight.start) / GLIDE_MS)
      const k = ease(t)
      pos.current = {
        x: flight.from.x + (flight.to.x - flight.from.x) * k,
        y: flight.from.y + (flight.to.y - flight.from.y) * k,
      }
      draw()
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    // 停下以后跟着相机走
    const off = engine.onMove(draw)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(hide)
      off()
    }
  }, [engine, cursor])

  return (
    <div
      ref={ref}
      aria-hidden
      data-visible={visible || undefined}
      className="plein-agent-cursor pointer-events-none fixed top-0 left-0 z-20"
    >
      <svg width="18" height="20" viewBox="0 0 18 20" className="plein-agent-cursor-arrow">
        <title>小满的光标</title>
        <path
          d="M2 1.5 16 9.2 9.4 10.6 6.2 17.5Z"
          fill="var(--accent)"
          stroke="var(--surface)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="plein-agent-cursor-label">
        <Mascot mood="working" size={16} />
        小满
      </span>
    </div>
  )
}
