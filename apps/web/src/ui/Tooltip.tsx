import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 全局悬停提示：接管页面上所有 `title` 属性，换成与应用一致的提示气泡，不再弹系统原生的黄色小框。
 * 指针移入时把 title 暂存到 data-tip 并留空占位（不弹原生提示），移出时还原，
 * 悬停期间同步 React 对 title 的更新，移出时还原最新说明。
 * 只有第一个提示等待；提示还在时移到相邻按钮，复用同一个气泡滑过去换字，不重新弹出。
 */
const SHOW_DELAY = 450
/** 移出后气泡多留一会儿，指针跨过按钮之间的空隙时还能接上 */
const HIDE_GRACE = 150
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
    let leaveTimer = 0
    let visible = false
    let lastHidden = 0
    let observer: MutationObserver | null = null
    const automaticLabels = new WeakMap<HTMLElement, string>()

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
      if (target && automaticLabels.has(target)) {
        if (target.getAttribute('aria-label') === automaticLabels.get(target))
          target.removeAttribute('aria-label')
        automaticLabels.delete(target)
      }
      target = null
    }
    const hide = () => {
      clearTimeout(timer)
      clearTimeout(leaveTimer)
      restore()
      if (visible) lastHidden = performance.now()
      visible = false
      setTip(null)
    }
    // 指针离开当前目标：还没显示就直接取消，已显示就留出接力的间隙
    const leave = () => {
      clearTimeout(timer)
      if (!visible) return hide()
      clearTimeout(leaveTimer)
      leaveTimer = window.setTimeout(hide, HIDE_GRACE)
    }

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      // 悬停目标里的节点被替换（如按钮换图标）时，浏览器不给已移除的节点派发 pointerout，
      // 只能在指针进入目标以外的元素时收起。
      if (target && !target.contains(e.target as Node)) leave()
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title]')
      if (el && el === target) clearTimeout(leaveTimer)
      if (!el || el === target) return
      const text = el.getAttribute('title')?.trim()
      // 气泡还在：换目标但不收起，下面立即显示新说明
      const hop = visible && !!text
      if (hop) {
        clearTimeout(timer)
        clearTimeout(leaveTimer)
        restore()
      } else hide()
      if (!text) return
      target = el
      el.dataset.tip = el.getAttribute('title') ?? ''
      el.setAttribute('title', '')
      // 图标按钮常只靠 title 说明用途，移走后补上无障碍名称
      if (
        (!el.hasAttribute('aria-label') && !el.textContent?.trim()) ||
        automaticLabels.get(el) === el.getAttribute('aria-label')
      ) {
        el.setAttribute('aria-label', text)
        automaticLabels.set(el, text)
      }
      const show = () => {
        const latest = el.dataset.tip?.trim()
        if (target === el && el.isConnected && latest) {
          visible = true
          setTip({ text: latest, rect: el.getBoundingClientRect() })
        }
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
        if (automaticLabels.has(el) && el.getAttribute('aria-label') === automaticLabels.get(el)) {
          el.setAttribute('aria-label', latest.trim())
          automaticLabels.set(el, latest.trim())
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
      if (hop || performance.now() - lastHidden < WARM_WINDOW) show()
      else timer = window.setTimeout(show, SHOW_DELAY)
    }
    const out = (e: PointerEvent) => {
      if (!target) return
      const next = e.relatedTarget as Node | null
      if (next && target.contains(next)) return
      leave()
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
  // 第一次直接就位并弹出，之后换目标时才滑过去
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.setAttribute('data-ready', ''))
    return () => cancelAnimationFrame(frame)
  }, [])

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
    const top = Math.max(
      8,
      Math.min(below ? rect.bottom + gap : rect.top - gap - h, window.innerHeight - h - 8),
    )
    setPos({ translate: `${left}px ${top}px` })
    el.style.setProperty('--pop-origin', below ? 'top center' : 'bottom center')
    el.style.setProperty('--pop-from', `translateY(${below ? -2 : 2}px) scale(0.98)`)
  }, [tip])

  return (
    <div
      ref={ref}
      role="tooltip"
      style={pos}
      className="ui-tooltip pointer-events-none fixed top-0 left-0 z-80 max-w-[min(280px,calc(100vw-16px))] break-words"
    >
      {tip.text}
    </div>
  )
}
