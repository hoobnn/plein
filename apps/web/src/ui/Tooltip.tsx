import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 全局悬停提示：接管页面上所有 `title` 属性，换成与应用一致的提示气泡，不再弹系统原生的黄色小框。
 * 指针移入时把 title 暂存到 data-tip（浏览器就不会再弹原生提示），移出时还原，
 * 悬停期间同步 React 对 title 的更新，移出时还原最新说明。
 */
const SHOW_DELAY = 450
/** 刚关掉一个提示后，移到相邻按钮时立即显示 */
const WARM_WINDOW = 400

interface Tip {
  text: string
  rect: DOMRect
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let target: HTMLElement | null = null
    let timer = 0
    let lastHidden = 0
    let observer: MutationObserver | null = null

    const restore = () => {
      observer?.disconnect()
      observer = null
      if (target?.dataset.tip !== undefined) {
        // React 刚更新、观察回调尚未执行时，也不能用旧提示覆盖新值。
        if (!target.hasAttribute('title')) target.setAttribute('title', target.dataset.tip)
        delete target.dataset.tip
      }
      target = null
    }
    const hide = () => {
      clearTimeout(timer)
      restore()
      setTip((t) => {
        if (t) lastHidden = performance.now()
        return null
      })
    }

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title]')
      if (!el || el === target) return
      hide()
      const text = el.getAttribute('title')?.trim()
      if (!text) return
      target = el
      el.dataset.tip = el.getAttribute('title') ?? ''
      el.removeAttribute('title')
      // 图标按钮常只靠 title 说明用途，移走后补上无障碍名称
      if (!el.hasAttribute('aria-label') && !el.textContent?.trim())
        el.setAttribute('aria-label', text)
      const show = () => {
        const latest = el.dataset.tip?.trim()
        if (target === el && el.isConnected && latest)
          setTip({ text: latest, rect: el.getBoundingClientRect() })
      }
      observer = new MutationObserver(() => {
        if (target !== el || !el.hasAttribute('title')) return
        const latest = el.getAttribute('title') ?? ''
        el.dataset.tip = latest
        el.removeAttribute('title')
        if (!latest.trim()) hide()
        else setTip((current) => (current ? { ...current, text: latest.trim() } : null))
      })
      observer.observe(el, { attributes: true, attributeFilter: ['title'] })
      if (performance.now() - lastHidden < WARM_WINDOW) show()
      else timer = window.setTimeout(show, SHOW_DELAY)
    }
    const out = (e: PointerEvent) => {
      if (!target) return
      const next = e.relatedTarget as Node | null
      if (next && target.contains(next)) return
      hide()
    }

    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('wheel', hide, { capture: true, passive: true })
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', hide, true)
      document.removeEventListener('wheel', hide, { capture: true })
      window.removeEventListener('blur', hide)
    }
  }, [])

  return tip ? createPortal(<Bubble tip={tip} />, document.body) : null
}

function Bubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { rect } = tip
    const w = el.offsetWidth
    const h = el.offsetHeight
    const gap = 6
    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8),
    )
    const below = rect.bottom + gap + h <= window.innerHeight - 8
    setPos({ left, top: below ? rect.bottom + gap : rect.top - gap - h })
  }, [tip])

  return (
    <div
      ref={ref}
      role="tooltip"
      style={pos}
      className="ui-tooltip pointer-events-none fixed z-80 max-w-70"
    >
      {tip.text}
    </div>
  )
}
