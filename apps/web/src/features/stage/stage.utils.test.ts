// @vitest-environment happy-dom
import { describe, expect, it } from 'vite-plus/test'
import { isSliderGestureTarget } from './stage.utils'

/** 滑杆拖动手势的识别：原生 range 与 Base UI Slider 的 thumb 都要认出来。 */
describe('isSliderGestureTarget', () => {
  const mount = (html: string) => {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host)
    return host.firstElementChild as Element
  }

  it('原生 range 输入直接命中', () => {
    const input = mount('<input type="range" min="0" max="10" />')
    expect(isSliderGestureTarget(input)).toBe(true)
  })

  it('Base UI Slider 的 thumb 与根节点都算滑杆手势', () => {
    const root = mount(
      '<div data-slot="slider"><div data-slot="slider-thumb"><input type="range" aria-label="宽" /></div></div>',
    )
    // 真实 DOM 里指针事件落在 thumb 的 DIV 上
    const thumb = root.querySelector('[data-slot="slider-thumb"]')!
    expect(isSliderGestureTarget(thumb)).toBe(true)
    // thumb 内的原生输入框（Base UI 实际的 role=slider 载体）也是滑杆手势
    expect(isSliderGestureTarget(thumb.firstElementChild!)).toBe(true)
    expect(isSliderGestureTarget(root)).toBe(true)

    const track = mount(
      '<div data-slot="slider"><div data-slot="slider-track"><div data-slot="slider-range" /></div></div>',
    )
    expect(isSliderGestureTarget(track.querySelector('[data-slot="slider-range"]')!)).toBe(true)
  })

  it('画布与其他控件不算滑杆手势', () => {
    const host = document.createElement('div')
    host.innerHTML =
      '<canvas></canvas><button type="button">截图</button><input type="text" /><div data-slot="select-trigger" />'
    document.body.append(host)
    for (const el of [...host.children]) expect(isSliderGestureTarget(el)).toBe(false)
    expect(isSliderGestureTarget(host)).toBe(false)
  })

  it('非元素目标（window、null）不算滑杆手势', () => {
    expect(isSliderGestureTarget(null)).toBe(false)
    expect(isSliderGestureTarget(window)).toBe(false)
  })
})
