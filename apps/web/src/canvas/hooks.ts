import type { Engine } from '@plein/canvas-core'
import type { PleinDoc } from '@plein/doc'
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'

/** 订阅一组事件源，任一触发就递增版本号，驱动组件重渲染 */
function useVersion(subscribe: (bump: () => void) => () => void) {
  const ref = useRef(0)
  return useSyncExternalStore(
    (notify) =>
      subscribe(() => {
        ref.current++
        notify()
      }),
    () => ref.current,
  )
}

/**
 * 引擎状态（工具、缩放、撤销栈）、选中或文档内容变化时递增：浮在元素旁的面板靠它重渲染。
 * 不跟随平移和拖动预览：位置用 useFollow 逐帧直接改，不走 React。
 */
export function useEngineVersion(engine: Engine) {
  return useVersion((bump) => {
    const offs = [
      engine.onStateChange(bump),
      engine.selection.onChange(bump),
      engine.doc.subscribe(bump),
    ]
    return () => {
      for (const off of offs) off()
    }
  })
}

/** 跟随时会改的定位属性；place 没给的清掉（面板在元素上方 / 下方之间切换时） */
const FOLLOW_KEYS = ['top', 'left', 'right', 'bottom', 'width', 'maxWidth', 'maxHeight'] as const
type FollowStyle = Pick<CSSProperties, (typeof FOLLOW_KEYS)[number]>

/**
 * 浮在元素旁的面板跟随相机和拖动：每帧在画布绘制前直接写 DOM 的定位，不触发重渲染。
 * place 和渲染时用的是同一个函数，返回 null 表示这一帧不动（元素已不在了，等重渲染卸载）。
 */
export function useFollow<T extends HTMLElement>(engine: Engine, place: () => FollowStyle | null) {
  const ref = useRef<T>(null)
  const placeRef = useRef(place)
  placeRef.current = place
  const sync = useCallback(() => {
    const node = ref.current
    const style = node && placeRef.current()
    if (!node || !style) return
    for (const key of FOLLOW_KEYS) {
      const v = style[key]
      const css = v === undefined ? '' : typeof v === 'number' ? `${v}px` : String(v)
      if (node.style[key] !== css) node.style[key] = css
    }
  }, [])
  useEffect(() => {
    const offMove = engine.onMove(sync)
    const offInsets = engine.camera.onInsetsChange(sync)
    return () => {
      offMove()
      offInsets()
    }
  }, [engine, sync])
  // 窗口变宽变窄后，面板要按新的可用空间重新放置。
  useEffect(() => {
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [sync])
  // 选区为空时没有 DOM；之后挂载或换行改变高度，也要立即重新放置。
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    sync()
    let frame = 0
    // 定位可能改变观察对象自身的宽高；放到下一帧，避免在尺寸通知中再次重排。
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(sync)
    })
    resize.observe(node)
    return () => {
      resize.disconnect()
      cancelAnimationFrame(frame)
    }
  })
  return ref
}

/** 选中变化时递增 */
export function useSelectionVersion(engine: Engine) {
  return useVersion((bump) => engine.selection.onChange(bump))
}

/** 文档内容变化时递增（含协作者的修改）：列表、表格类面板靠它刷新 */
export function useDocVersion(doc: PleinDoc) {
  return useVersion((bump) => doc.subscribe(bump))
}
