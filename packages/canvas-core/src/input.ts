import type { Camera } from './camera'

/** 平移模式：空格按住、或当前是抓手工具时，左键拖拽平移画布 */
export interface PanState {
  space: boolean
  hand: boolean
}

export const isEditableTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)

/**
 * 触控板/滚轮/拖拽输入。
 * - 触控板双指滑动 = 平移；捏合（ctrlKey wheel）= 缩放
 * - 鼠标滚轮 + ⌘/Ctrl = 缩放
 * - 空格 + 拖拽、抓手工具拖拽、中键拖拽 = 平移，松手带惯性
 */
export function attachInput(el: HTMLElement, camera: Camera, pan: PanState) {
  let dragging = false
  let lastX = 0
  let lastY = 0
  let vx = 0
  let vy = 0
  let lastT = 0
  let inertiaRaf = 0

  const idleCursor = () => (pan.space || pan.hand ? 'grab' : '')

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    if (e.ctrlKey || e.metaKey) {
      // 捏合手势 deltaY 很小，滚轮很大，用指数映射统一手感
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01))
      camera.zoomAt(sx, sy, factor)
    } else {
      camera.panBy(-e.deltaX, -e.deltaY)
    }
  }

  const stopInertia = () => cancelAnimationFrame(inertiaRaf)

  const onPointerDown = (e: PointerEvent) => {
    const panning = e.button === 1 || (e.button === 0 && (pan.space || pan.hand))
    if (!panning) return
    stopInertia()
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    lastT = performance.now()
    vx = vy = 0
    el.setPointerCapture(e.pointerId)
    el.style.cursor = 'grabbing'
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return
    // 合并事件，高刷屏下更顺滑
    const events = e.getCoalescedEvents?.() ?? [e]
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
      camera.panBy(dx, dy)
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return
    dragging = false
    el.releasePointerCapture(e.pointerId)
    el.style.cursor = idleCursor()
    // 惯性：指数衰减
    let px = vx * 16
    let py = vy * 16
    const step = () => {
      px *= 0.92
      py *= 0.92
      if (Math.hypot(px, py) < 0.1) return
      camera.panBy(px, py)
      inertiaRaf = requestAnimationFrame(step)
    }
    inertiaRaf = requestAnimationFrame(step)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !e.repeat && !isEditableTarget(e.target)) {
      e.preventDefault()
      pan.space = true
      el.style.cursor = 'grab'
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      pan.space = false
      if (!dragging) el.style.cursor = idleCursor()
    }
  }
  const onBlur = () => {
    pan.space = false
  }

  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  return () => {
    stopInertia()
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', onPointerUp)
    el.removeEventListener('pointercancel', onPointerUp)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
  }
}
