import type { Camera } from './camera'

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
 * - 空格 + 拖拽、抓手工具拖拽、中键拖拽 = 平移，松手带惯性
 */
export function attachInput(el: HTMLElement, camera: Camera, pan: PanState) {
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
    const id = pointer
    pointer = null
    vx = vy = 0
    if (id !== null && el.hasPointerCapture(id)) el.releasePointerCapture(id)
    el.style.cursor = idleCursor()
  }
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
      move(() => camera.panBy(-e.deltaX, -e.deltaY))
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    if (pointer !== null) return
    stopInertia()
    const panning = e.button === 1 || (e.button === 0 && (pan.space || pan.hand))
    if (!panning) return
    pointer = e.pointerId
    lastX = e.clientX
    lastY = e.clientY
    lastT = performance.now()
    vx = vy = 0
    el.setPointerCapture(e.pointerId)
    el.style.cursor = 'grabbing'
  }

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return
    // 合并事件，高刷屏下更顺滑
    const coalesced = e.getCoalescedEvents?.()
    const events = coalesced?.length ? coalesced : [e]
    for (const ev of events) {
      const dx = ev.clientX - lastX
      const dy = ev.clientY - lastY
      const now = performance.now()
      const dt = Math.max(1, now - lastT)
      vx = dx / dt
      vy = dy / dt
      lastX = ev.clientX
      lastY = ev.clientY
      lastT = now
      move(() => camera.panBy(dx, dy))
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return
    pointer = null
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    el.style.cursor = idleCursor()
    // 已经按住停稳时，不能用最后一次移动的旧速度再次甩动画布。
    if (performance.now() - lastT > 100) return
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

  const onKeyDown = (e: KeyboardEvent) => {
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

  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerCancel)
  el.addEventListener('lostpointercapture', onPointerCancel)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  return {
    cancel,
    dispose: () => {
      offCamera()
      cancel()
      el.style.cursor = ''
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('lostpointercapture', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    },
  }
}
