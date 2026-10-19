import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 全局悬停提示：接管页面上所有 `title` 属性，换成与应用一致的提示气泡，不再弹系统原生的黄色小框。
 * 指针移入时把 title 暂存到 data-tip 并留空占位（不弹原生提示），移出时还原，
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
      // 回调前退出悬停时，也要尊重 React 已经清空或移除标题的决定。
      const changed = observer
        ?.takeRecords()
        .some((record) => record.target === target && record.attributeName === 'title')
      observer?.disconnect()
      observer = null
      if (target?.dataset.tip !== undefined) {
        // React 刚更新、观察回调尚未执行时，也不能用旧提示覆盖新值。
        if (!changed && target.getAttribute('title') === '')
          target.setAttribute('title', target.dataset.tip)
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
      el.setAttribute('title', '')
      // 图标按钮常只靠 title 说明用途，移走后补上无障碍名称
      if (!el.hasAttribute('aria-label') && !el.textContent?.trim())
        el.setAttribute('aria-label', text)
      const show = () => {
        const latest = el.dataset.tip?.trim()
        if (target === el && el.isConnected && latest)
          setTip({ text: latest, rect: el.getBoundingClientRect() })
      }
      const observe = () => {
        observer?.observe(el, { attributes: true, attributeFilter: ['title'] })
        // 属性观察看不到来源节点被其祖先移除；只在有悬停目标期间检查连接状态。
        observer?.observe(document.body, { childList: true, subtree: true })
      }
      observer = new MutationObserver((records) => {
        if (target !== el) return
        if (!el.isConnected) return hide()
        if (!records.some((record) => record.target === el && record.attributeName === 'title'))
          return
        const latest = el.getAttribute('title') ?? ''
        if (!latest.trim()) {
          delete el.dataset.tip
          hide()
          return
        }
        el.dataset.tip = latest
        // 不观察自己写入的空占位，后续 React 的空值／移除才能被区分出来。
        observer?.disconnect()
        el.setAttribute('title', '')
        observe()
        setTip((current) =>
          current ? { text: latest.trim(), rect: el.getBoundingClientRect() } : null,
        )
      })
      observe()
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
      className="ui-tooltip pointer-events-none fixed z-80 max-w-70 break-words"
    >
      {tip.text}
    </div>
  )
}
