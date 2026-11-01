/** 双指平移过程中浮动编辑器可能移到光标下，短暂停顿后才把滚动交还编辑器。 */
export function attachWheelContinuation(host: HTMLElement) {
  const gap = 200
  let last = -Infinity
  let ctrl = false
  let meta = false
  const remember = (event: WheelEvent) => {
    last = performance.now()
    ctrl = event.ctrlKey
    meta = event.metaKey
  }
  const continueWheel = (event: WheelEvent) => {
    if (!(event.target instanceof Element)) return
    if (host.contains(event.target)) return
    const continued =
      performance.now() - last < gap && event.ctrlKey === ctrl && event.metaKey === meta
    if (!continued || !event.target.closest('.plein-node-editor')) {
      last = -Infinity
      return
    }
    // 编辑器与画布宿主是兄弟层，把仍在进行的画布手势转交宿主。
    const forwarded = new WheelEvent('wheel', event)
    host.dispatchEvent(forwarded)
    if (forwarded.defaultPrevented) event.preventDefault()
    event.stopPropagation()
  }
  const reset = () => {
    last = -Infinity
  }
  host.addEventListener('wheel', remember, { passive: true })
  window.addEventListener('wheel', continueWheel, { capture: true, passive: false })
  window.addEventListener('pointerdown', reset, true)
  window.addEventListener('blur', reset)
  return () => {
    host.removeEventListener('wheel', remember)
    window.removeEventListener('wheel', continueWheel, true)
    window.removeEventListener('pointerdown', reset, true)
    window.removeEventListener('blur', reset)
  }
}
