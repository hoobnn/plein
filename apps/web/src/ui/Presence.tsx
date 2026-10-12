import {
  createContext,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * 浮层的退场动画：子元素从有变成没有（null / false）时，先保留上一次的内容并标上 data-closing，
 * 等收起动画（controls.css 的 ui-pop-out / ui-fade-out）播完再卸载。
 *
 * 用法：`<Presence>{open && <Menu />}</Presence>`。要播放退场的元素用 `useExit()` 拿到属性铺上去，
 * 可以是渲染到 body 的弹层，不要求是 Presence 的 DOM 后代。
 * 收起途中又打开：直接换回新内容，进场动画重新开始。减少动态效果时立即卸载。
 */

interface Ctx {
  id: string
  closing: boolean
}
const PresenceContext = createContext<Ctx | null>(null)

/** 最长等多久：动画被打断或没触发时也一定卸载 */
const MAX_EXIT = 1000
const EXIT_ANIMATIONS = new Set(['ui-pop-out', 'ui-fade-out'])

export function Presence({ children }: { children: ReactNode }) {
  const id = useId()
  const show = children !== null && children !== undefined && children !== false
  const last = useRef<ReactNode>(null)
  const [leaving, setLeaving] = useState(false)
  const [wasShown, setWasShown] = useState(show)
  if (show !== wasShown) {
    setWasShown(show)
    setLeaving(!show)
  }
  if (show) last.current = children

  useLayoutEffect(() => {
    if (!leaving) return
    let done = false
    const finish = () => {
      if (done) return
      done = true
      last.current = null
      setLeaving(false)
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
      return
    }
    const els = document.querySelectorAll(`[data-presence="${CSS.escape(id)}"]`)
    const anims = [...els].flatMap((el) =>
      el
        .getAnimations()
        .filter((a) => a instanceof CSSAnimation && EXIT_ANIMATIONS.has(a.animationName)),
    )
    if (!anims.length) {
      finish()
      return
    }
    const timer = window.setTimeout(finish, MAX_EXIT)
    void Promise.allSettled(anims.map((a) => a.finished)).then(finish)
    // 收起途中又打开：不再卸载
    return () => {
      done = true
      clearTimeout(timer)
    }
  }, [leaving, id])

  if (!show && !leaving) return null
  return (
    <PresenceContext.Provider value={{ id, closing: !show }}>
      {show ? children : last.current}
    </PresenceContext.Provider>
  )
}

/** 正在收起：点外面、按 Esc 这类关闭逻辑应当不再响应 */
export function useClosing() {
  return useContext(PresenceContext)?.closing ?? false
}

/** 铺到要播放进退场的元素上；不在 Presence 里时为空 */
export function useExit(): { 'data-presence'?: string; 'data-closing'?: '' } {
  const ctx = useContext(PresenceContext)
  if (!ctx) return {}
  return { 'data-presence': ctx.id, 'data-closing': ctx.closing ? '' : undefined }
}
