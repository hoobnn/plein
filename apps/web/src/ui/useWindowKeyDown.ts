import { useEffect, useRef } from 'react'

/**
 * 窗口级快捷键：监听器只注册一次，每次按键调用最新的处理函数。
 * 处理函数每次渲染都会重建，直接放进依赖数组会让监听器反复重挂。
 */
export function useWindowKeyDown(
  handler: (event: KeyboardEvent) => void,
  options?: { capture?: boolean },
) {
  const latest = useRef(handler)
  latest.current = handler
  const capture = options?.capture ?? false
  useEffect(() => {
    const on = (event: KeyboardEvent) => latest.current(event)
    window.addEventListener('keydown', on, capture)
    return () => window.removeEventListener('keydown', on, capture)
  }, [capture])
}
