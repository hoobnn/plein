import type { MouseEvent } from 'react'
import { routeHash } from '../router'

/** 顶栏左侧的 Logo，首页和画布共用一份，尺寸一致，切换页面时靠 app-brand 滑到新位置 */
export function Brand({ onClick }: { onClick?(e: MouseEvent<HTMLAnchorElement>): void }) {
  return (
    <a
      href={routeHash({ name: 'home' })}
      onClick={onClick}
      className="app-brand ui-bar-btn gap-2 px-2.5 font-semibold text-ink"
    >
      <span className="plein-logo size-5" aria-hidden="true" />
      Plein
    </a>
  )
}

/** 普通左键点击（没按修饰键）：可以接管成页内动画；⌘/中键点击仍交给浏览器开新标签 */
export function isPlainClick(e: MouseEvent) {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}
