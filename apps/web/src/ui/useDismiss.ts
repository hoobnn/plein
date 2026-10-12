import { useEffect, useRef } from 'react'

/**
 * 点外面、按 Esc 时关闭的浮层；`wheel` 为真时在外面滚动也关闭（画布上的菜单，滚轮会移动画布）。
 * 返回挂到浮层根节点上的 ref。
 */
export function useDismiss<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  { active = true, wheel = false }: { active?: boolean; wheel?: boolean } = {},
) {
  const ref = useRef<T>(null)
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!active) return
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) latest.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', key)
    if (wheel) window.addEventListener('wheel', outside, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('wheel', outside, true)
    }
  }, [active, wheel])
  return ref
}
