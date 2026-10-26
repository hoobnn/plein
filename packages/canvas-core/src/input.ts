import type { Camera } from './camera'
import { attachTouchNavigation } from './touch'

/** 平移模式：空格按住、或当前是抓手工具时，左键拖拽平移画布 */
export interface PanState {
  space: boolean
  hand: boolean
}

export const isOverlayTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && t.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null

export const isEditableTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t instanceof HTMLMediaElement ||
    // 浮层及编辑器自己处理按键和剪贴板，不能穿透到背后的画布。
    t.closest('[data-plein-active], [data-plein-scroll]') !== null ||
    isOverlayTarget(t))

/** 控件上的 Tab、空格和方向键保留给浏览器；组合键仍可用于画布命令。 */
export const isControlTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  t.closest('button, a[href], select, [role="button"], [role="separator"]') !== null

/**
 * 触控板/滚轮/拖拽输入。
 * - 触控板双指滑动 = 平移；捏合（ctrlKey wheel）= 缩放
 * - 鼠标滚轮 + ⌘/Ctrl = 缩放
 * - 右键拖动、空格 + 拖拽、抓手工具拖拽、中键拖拽 = 平移，松手带惯性
 * - 右键轻点在松开时打开菜单，移动达到 3px 后只平移、不弹菜单
 */
export function attachInput(
  el: HTMLElement,
  camera: Camera,
  pan: PanState,
  onContextClick?: (event: MouseEvent) => void,
) {
  let right = false
  let rightDragged = false
  let rightHandled = false
  let startX = 0
  let startY = 0
  let pointer: number | null = null
  let lastX = 0
  let lastY = 0
  let vx = 0
  let vy = 0
  let lastT = 0
  let inertiaRaf = 0
  let movingCamera = false

  const idleCursor = () => (pan.space || pan.hand ? 'grab' : '')
  const move = (fn: () => void) => {
    movingCamera = true
    try {
      fn()
    } finally {
      movingCamera = false
    }
  }
  const stopInertia = () => {
    cancelAnimationFrame(inertiaRaf)
    inertiaRaf = 0
  }
  const cancel = () => {
    stopInertia()
    touch.cancel()
    const id = pointer
    pointer = null
    right = false
    rightDragged = false
    vx = vy = 0
    if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id)
    el.style.cursor = idleCursor()
  }
  const touch = attachTouchNavigation(el, camera, { enabled: () => pan.hand, begin: cancel, move })
  // 侧栏、小地图、缩放或动画等外部导航接管时，不再沿用旧平移。
  const offCamera = camera.onChange(() => {
    if (!movingCamera) cancel()
  })

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    cancel()
    const rect = el.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    if (e.ctrlKey || e.metaKey) {
      // 捏合手势 deltaY 很小，滚轮很大，用指数映射统一手感
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01))
      move(() => camera.zoomAt(sx, sy, factor))
    } else {
      // 鼠标也可能按行或按页报告滚动量，先换成屏幕像素；画布没有文本行，约定一行为 16px。
      const sx = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? camera.width : 1
      const sy = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? camera.height : 1
      move(() => camera.panBy(-e.deltaX * sx, -e.deltaY * sy))
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && pan.hand) return
    if (pointer !== null) return
    stopInertia()
    rightHandled = false
    const panning = e.button === 2 || e.button === 1 || (e.button === 0 && (pan.space || pan.hand))
    if (!panning) return
    touch.cancel()
    pointer = e.pointerId
    right = e.button === 2
    rightDragged = false
    rightHandled = right
    startX = e.clientX
    startY = e.clientY
    lastX = e.clientX
    lastY = e.clientY
    lastT = e.timeStamp
    vx = vy = 0
    el.setPointerCapture(e.pointerId)
    if (!right) el.style.cursor = 'grabbing'
  }

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return
    // 合并事件，高刷屏下更顺滑。速度按事件发生时间算：合并事件在同一次回调里处理，
    // 用处理时刻会把间隔压成 0，主线程卡顿时甩出的速度成倍虚高。
    const coalesced = e.getCoalescedEvents?.()
    const events = coalesced?.length ? coalesced : [e]
    for (const ev of events) {
      if (right && !rightDragged) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) continue
        rightDragged = true
        el.style.cursor = 'grabbing'
      }
      const dx = ev.clientX - lastX
      const dy = ev.clientY - lastY
      const dt = Math.max(1, ev.timeStamp - lastT)
      vx = dx / dt
      vy = dy / dt
      lastX = ev.clientX
      lastY = ev.clientY
      lastT = ev.timeStamp
      move(() => camera.panBy(dx, dy))
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return
    if (right && !rightDragged) onPointerMove(e)
    const contextClick = right && !rightDragged
    right = false
    rightDragged = false
    pointer = null
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    el.style.cursor = idleCursor()
    if (contextClick) {
      onContextClick?.(e)
      return
    }
    // 已经按住停稳时，不能用最后一次移动的旧速度再次甩动画布。
    // 同样按事件时间判断，渲染慢时松手事件排在一帧之后处理，不算停稳。
    if (e.timeStamp - lastT > 100) return
    // 惯性：指数衰减
    let px = vx * 16
    let py = vy * 16
    const step = () => {
      px *= 0.92
      py *= 0.92
      if (Math.hypot(px, py) < 0.1) {
        inertiaRaf = 0
        return
      }
      move(() => camera.panBy(px, py))
      inertiaRaf = requestAnimationFrame(step)
    }
    inertiaRaf = requestAnimationFrame(step)
  }
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId === pointer) cancel()
  }
  // Linux 上中键松开会粘贴主选区，中键只用来平移，不能顺带往画布里贴内容。
  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault()
  }

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    // macOS 可在按下时发菜单事件，Windows/Linux 也可能在松开后发。
    // 鼠标右键由 pointerup 统一判定轻点或拖动，避免提前打开或重复打开菜单。
    if (!rightHandled) onContextClick?.(e)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) rightHandled = false
    if (
      e.code === 'Space' &&
      !e.repeat &&
      !e.defaultPrevented &&
      !e.isComposing &&
      !isEditableTarget(e.target) &&
      !isControlTarget(e.target)
    ) {
      e.preventDefault()
      pan.space = true
      if (pointer === null) el.style.cursor = idleCursor()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      pan.space = false
      if (pointer === null) el.style.cursor = idleCursor()
    }
  }
  const onBlur = () => {
    pan.space = false
    cancel()
  }

  el.addEventListener('contextmenu', onContextMenu)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerCancel)
  el.addEventListener('lostpointercapture', onPointerCancel)
  el.addEventListener('mouseup', onMouseUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  return {
    cancel,
    dispose: () => {
      offCamera()
      cancel()
      touch.dispose()
      el.style.cursor = ''
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('lostpointercapture', onPointerCancel)
      el.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}
