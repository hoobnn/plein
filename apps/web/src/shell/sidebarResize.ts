import { useSidebar } from '../stores/sidebar'

/** 一次调整只由启动指针提交；取消、失焦和卸载均恢复原宽度，不写偏好。 */
export function startSidebarResize(
  handle: HTMLElement,
  { pointerId, clientX: startX }: Pick<PointerEvent, 'pointerId' | 'clientX'>,
  onFinish: () => void,
) {
  const { width: startW, setWidth } = useSidebar.getState()
  let finished = false
  handle.setPointerCapture(pointerId)
  document.documentElement.classList.add('plein-resizing')
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) setWidth(startW + ev.clientX - startX, false)
  }
  const finish = (commit: boolean) => {
    if (finished) return
    finished = true
    setWidth(commit ? useSidebar.getState().width : startW, commit)
    document.documentElement.classList.remove('plein-resizing')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', interrupted)
    handle.removeEventListener('lostpointercapture', interrupted)
    window.removeEventListener('blur', abort)
    window.removeEventListener('keydown', key, true)
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
    onFinish()
  }
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    move(ev)
    finish(true)
  }
  const abort = () => finish(false)
  const interrupted = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) abort()
  }
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || ev.isComposing || ev.keyCode === 229) return
    ev.preventDefault()
    ev.stopPropagation()
    abort()
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', interrupted)
  handle.addEventListener('lostpointercapture', interrupted)
  window.addEventListener('blur', abort)
  window.addEventListener('keydown', key, true)
  return abort
}
