// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { renderMarkdown } from './markdown'
import { attachPreviewInteractions } from './markdownOverlay'

/** 造一个带两个滚动区的预览层，并接上滚轮与键盘交互。 */
function preview() {
  const root = document.createElement('div')
  const host = document.createElement('div')
  document.body.append(root, host)
  const node = document.createElement('div')
  node.className = 'plein-md plein-md-preview'
  node.innerHTML = renderMarkdown('```text\n第一段超长代码\n```\n\n```text\n第二段超长代码\n```')
  root.appendChild(node)
  attachPreviewInteractions(node, host)
  const regions = Array.from(node.querySelectorAll<HTMLElement>('[data-plein-scroll]'))
  const forwarded: WheelEvent[] = []
  host.addEventListener('wheel', (event) => forwarded.push(event as WheelEvent))
  return { node, host, regions, forwarded }
}

/** 让滚动区看起来比视口宽。 */
function wide(region: HTMLElement, clientWidth = 200, scrollWidth = 800) {
  Object.defineProperty(region, 'clientWidth', { value: clientWidth, configurable: true })
  Object.defineProperty(region, 'scrollWidth', { value: scrollWidth, configurable: true })
}

/** 派发一次滚轮；happy-dom 不带修饰键，这里手动补上。 */
function wheel(
  target: HTMLElement,
  init: { deltaX: number; deltaY: number; shiftKey?: boolean; ctrlKey?: boolean },
) {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: init.deltaX,
    deltaY: init.deltaY,
  })
  for (const key of ['shiftKey', 'ctrlKey'] as const) {
    const value = init[key]
    if (value !== undefined) Object.defineProperty(event, key, { value })
  }
  target.dispatchEvent(event)
  return event
}

/** 派发一次按键。 */
function press(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}

describe('预览区滚轮', () => {
  it('斜向滚动按主方向分流，竖向滚轮交给画布', () => {
    const f = preview()
    const region = f.regions[0]!
    wide(region)
    const vertical = wheel(region, { deltaX: 3, deltaY: 70 })
    expect(vertical.defaultPrevented).toBe(false)
    expect(f.forwarded).toHaveLength(1)
    expect(f.forwarded[0]!.deltaY).toBe(70)
    expect(region.scrollLeft).toBe(0)
    const horizontal = wheel(region, { deltaX: 90, deltaY: 3 })
    expect(horizontal.defaultPrevented).toBe(false)
    expect(f.forwarded).toHaveLength(1)
  })

  it('Shift 优先横向，把竖向滚轮变成横向滚动', () => {
    const f = preview()
    const region = f.regions[0]!
    wide(region)
    const event = wheel(region, { deltaX: 3, deltaY: 80, shiftKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(region.scrollLeft).toBe(80)
    expect(f.forwarded).toHaveLength(0)
  })

  it('Ctrl 滚轮留给画布缩放，宽度不够时也不吞滚轮', () => {
    const f = preview()
    const region = f.regions[0]!
    wide(region)
    wheel(region, { deltaX: 90, deltaY: 3, ctrlKey: true })
    expect(f.forwarded).toHaveLength(1)
    const narrow = f.regions[1]!
    wide(narrow, 400, 400)
    wheel(narrow, { deltaX: 3, deltaY: 80, shiftKey: true })
    expect(f.forwarded).toHaveLength(2)
    expect(narrow.scrollLeft).toBe(0)
  })
})

describe('预览区快捷键', () => {
  it('全选只覆盖当前区域', () => {
    const f = preview()
    const region = f.regions[0]!
    region.focus()
    const event = press(region, 'a', { ctrlKey: true })
    expect(event.defaultPrevented).toBe(true)
    const selected = window.getSelection()!.toString()
    expect(selected).toContain('第一段超长代码')
    expect(selected).not.toContain('第二段超长代码')
  })

  it('Esc 先取消文本选择，再次按下才交回画布', () => {
    const f = preview()
    const region = f.regions[0]!
    region.focus()
    press(region, 'a', { ctrlKey: true })
    expect(window.getSelection()!.isCollapsed).toBe(false)
    const event = press(region, 'Escape')
    expect(event.defaultPrevented).toBe(true)
    expect(window.getSelection()!.isCollapsed).toBe(true)
  })

  it('选区不在当前区域时 Esc 不被区域拦截', () => {
    const f = preview()
    const region = f.regions[0]!
    const other = f.regions[1]!
    window.getSelection()!.selectAllChildren(other)
    const event = press(region, 'Escape')
    expect(event.defaultPrevented).toBe(false)
  })
})
