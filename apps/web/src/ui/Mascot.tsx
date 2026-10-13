import { useEffect, useRef } from 'react'
import type { Mood } from '../stores/agent'

/**
 * 吉祥物「小满」：与应用图标一致的蓝灰色独角鲸，带奶油色螺纹角与肚皮。
 * 眼睛跟着指针看，隔几秒眨一次眼。
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
      <ellipse className="plein-mascot-shadow" cx="32" cy="59" rx="13" ry="2" />
      <g className="plein-mascot-body">
        {/* 应用图标的蓝灰身体、深色描边与奶油色肚皮 */}
        <path
          className="plein-mascot-whale"
          d="M46 37c6 0 8-4 8-9-4-1-6-4-5-8 4 0 7 2 8 5 1-3 3-5 6-5 0 5-2 8-5 9 1 10-3 16-12 18z"
        />
        <path
          className="plein-mascot-whale"
          d="M30 15C17 15 6 24 6 37c0 11 9 18 23 18s24-7 24-18c0-12-10-22-23-22z"
        />
        <path
          className="plein-mascot-belly"
          d="M14 49c1-6 10-10 20-10 7 0 12 2 15 6-4 6-11 10-20 10-6 0-11-2-15-6z"
        />
        {/* 向左上方倾斜的螺纹角 */}
        <path
          className="plein-mascot-horn"
          d="M23 23c-3 2-6 1-8-2L5 5C3 1 8 3 11 5l14 12c3 3 1 5-2 6z"
        />
        <path className="plein-mascot-horn-line" d="M9 11c3 0 5-2 5-4m1 13c4-1 6-4 5-7" />
        {/* 图标里向前抱起的胸鳍 */}
        <path
          className="plein-mascot-whale"
          d="M40 33c4-2 12 5 14 12 1 3-1 6-4 5-7-3-14-14-10-17z"
        />
        <g ref={eyes} className="plein-mascot-eyes">
          <g className="plein-mascot-open">
            <circle cx="18" cy="33" r="2.7" />
            {mood === 'working' ? (
              <ellipse cx="35" cy="28.5" rx="2.4" ry="3" />
            ) : (
              <path className="plein-mascot-wink" d="m37 26-4 4 5-1" />
            )}
          </g>
          {/* 开心：弯弯眼；难过：耷拉眼 */}
          <path className="plein-mascot-closed" d="M15.5 34q2.5-4 5 0m12-4q2.5-4 5 0" />
          <path className="plein-mascot-sad" d="m15.5 34 5-2m17-2-5-2" />
        </g>
        <path
          className="plein-mascot-mouth"
          d={
            mood === 'happy'
              ? 'M24 34q4 5 8-1'
              : mood === 'sad'
                ? 'M25 37q3-4 6-1'
                : 'M25 34q3 3 6-1'
          }
        />
        <ellipse className="plein-mascot-o" cx="28" cy="35" rx="1.7" ry="1.9" />
      </g>
    </svg>
  )
}
