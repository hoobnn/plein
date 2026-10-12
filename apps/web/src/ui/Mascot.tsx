import { useEffect, useRef } from 'react'
import type { Mood } from '../stores/agent'

/**
 * 吉祥物「小满」：一团带笔尖的墨滴。外壳只用灰阶（墨色身体、画布色五官），
 * 工作中才用强调蓝；眼睛跟着指针看，隔几秒眨一次眼。
 */
export function Mascot({ mood, size = 56 }: { mood: Mood; size?: number }) {
  const eyes = useRef<SVGGElement>(null)

  // 眼睛看向指针：只改 transform，不走 React 渲染
  useEffect(() => {
    const g = eyes.current
    if (!g) return
    let frame = 0
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const r = g.ownerSVGElement?.getBoundingClientRect()
        if (!r) return
        const dx = e.clientX - (r.left + r.width / 2)
        const dy = e.clientY - (r.top + r.height / 2)
        const d = Math.hypot(dx, dy) || 1
        const k = Math.min(1, d / 240) * 2.2
        g.style.transform = `translate(${((dx / d) * k).toFixed(2)}px, ${((dy / d) * k).toFixed(2)}px)`
      })
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
    }
  }, [])

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className="plein-mascot"
      data-mood={mood}
      aria-hidden="true"
    >
      <ellipse className="plein-mascot-shadow" cx="32" cy="59" rx="15" ry="2.6" />
      <g className="plein-mascot-body">
        {/* 头顶的笔尖 */}
        <path
          className="plein-mascot-ink"
          d="M30.6 10.5c-.9-4.6 1.6-8 6.4-8.5-1.2 2-2.2 4.6-2.6 8.2z"
        />
        <path
          className="plein-mascot-ink"
          d="M32 9.5c12.6 0 21.5 10.3 21.5 23.4 0 12.5-8.6 20.6-21.5 20.6s-21.5-8.1-21.5-20.6C10.5 19.8 19.4 9.5 32 9.5z"
        />
        <g ref={eyes} className="plein-mascot-eyes">
          <g className="plein-mascot-open">
            <ellipse cx="24.5" cy="31" rx="3.3" ry="4.4" />
            <ellipse cx="39.5" cy="31" rx="3.3" ry="4.4" />
          </g>
          {/* 开心：弯弯眼 */}
          <path className="plein-mascot-closed" d="M21 32c1.6-3 5.4-3 7 0M36 32c1.6-3 5.4-3 7 0" />
          {/* 难过：耷拉眼 */}
          <path className="plein-mascot-sad" d="M21.5 30.5l6 1.8M42.5 30.5l-6 1.8" />
        </g>
        <path className="plein-mascot-mouth" d="M28.5 40.5q3.5 3 7 0" />
        <ellipse className="plein-mascot-o" cx="32" cy="41.2" rx="1.8" ry="2" />
      </g>
      {/* 工作中：头顶的火花 */}
      <path
        className="plein-mascot-spark"
        d="M51 6l1.3 3.4L55.7 10.7 52.3 12 51 15.4 49.7 12 46.3 10.7 49.7 9.4z"
      />
    </svg>
  )
}
