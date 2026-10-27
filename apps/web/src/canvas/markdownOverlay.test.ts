import { describe, expect, it } from 'vite-plus/test'
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import {
  composingBlocksEscape,
  createMarkdownTarget,
  previewKeyAction,
  previewWheelDecision,
} from './markdownOverlay'

/** 打开一份文档并放入一张便签，返回便签 id。 */
function note() {
  const doc = openDoc()
  const id = createElement(doc, {
    kind: 'markdown',
    text: '便签原始正文',
    x: 0,
    y: 0,
    w: 360,
    h: 64,
  })
  return { doc, id }
}

describe('便签编辑目标', () => {
  it('打开时有效，只读、销毁与类型变化后失效', () => {
    const { doc, id } = note()
    const target = createMarkdownTarget(doc, id)
    expect(target.valid()).toBe(true)
    expect(target.ytext?.toString()).toBe('便签原始正文')
    doc.readOnly = true
    expect(target.valid()).toBe(false)
    doc.readOnly = false
    doc.ydoc.destroy()
    expect(target.valid()).toBe(false)
  })

  it('元素被替换、类型变化、锁定与正文换掉后都失效', () => {
    const { doc, id } = note()
    const target = createMarkdownTarget(doc, id)
    const original = doc.mutable(id)!
    doc.elementMaps.set(id, original.clone())
    expect(target.valid()).toBe(false)

    const second = note()
    const swap = createMarkdownTarget(second.doc, second.id)
    second.doc.mutable(second.id)!.set('kind', 'node')
    expect(swap.valid()).toBe(false)

    const third = note()
    const lock = createMarkdownTarget(third.doc, third.id)
    third.doc.mutable(third.id)!.set('locked', true)
    expect(lock.valid()).toBe(false)

    const fourth = note()
    const text = createMarkdownTarget(fourth.doc, fourth.id)
    const source = fourth.doc.getText(fourth.id)!
    fourth.doc.mutable(fourth.id)!.set('text', source.clone())
    const next = fourth.doc.getText(fourth.id)!
    next.delete(0, next.length)
    next.insert(0, '替换后的新正文')
    expect(text.valid()).toBe(false)
  })
})

describe('预览区滚轮路由', () => {
  const wide = { clientWidth: 200, scrollWidth: 800 }
  it('斜向滚动按主方向分流，竖向滚轮交给画布', () => {
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        deltaX: 3,
        deltaY: 70,
        deltaMode: 0,
      }),
    ).toEqual({ consumed: false })
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        deltaX: 90,
        deltaY: 3,
        deltaMode: 0,
      }),
    ).toEqual({ consumed: true })
  })
  it('Shift 优先横向，把竖向滚轮换算成横向滚动量', () => {
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        deltaX: 3,
        deltaY: 80,
        deltaMode: 0,
      }),
    ).toEqual({ consumed: true, scrollLeft: 80 })
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        deltaX: 2,
        deltaY: 3,
        deltaMode: 1,
      }),
    ).toEqual({ consumed: true, scrollLeft: 48 })
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        deltaX: 2,
        deltaY: 3,
        deltaMode: 2,
      }),
    ).toEqual({ consumed: true, scrollLeft: 600 })
  })
  it('Ctrl 与 Meta 保留给画布缩放，宽度不够时也不吞滚轮', () => {
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        deltaX: 90,
        deltaY: 3,
        deltaMode: 0,
      }),
    ).toEqual({ consumed: false })
    expect(
      previewWheelDecision({
        ...wide,
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        deltaX: 3,
        deltaY: 80,
        deltaMode: 0,
      }),
    ).toEqual({ consumed: false })
    expect(
      previewWheelDecision({
        clientWidth: 200,
        scrollWidth: 200,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        deltaX: 3,
        deltaY: 80,
        deltaMode: 0,
      }),
    ).toEqual({ consumed: false })
  })
})

describe('预览区快捷键', () => {
  const base = {
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    composing: false,
    selectionInside: false,
  }
  it('全选只覆盖当前区域，Esc 取消选择', () => {
    expect(previewKeyAction({ ...base, key: 'a', ctrlKey: true })).toBe('select-all')
    expect(previewKeyAction({ ...base, key: 'a', metaKey: true })).toBe('select-all')
    expect(previewKeyAction({ ...base, key: 'a', ctrlKey: true, shiftKey: true })).toBe('none')
    expect(previewKeyAction({ ...base, key: 'a', ctrlKey: true, altKey: true })).toBe('none')
    expect(previewKeyAction({ ...base, key: 'Escape', selectionInside: true })).toBe('collapse')
    expect(previewKeyAction({ ...base, key: 'Escape', selectionInside: false })).toBe('none')
  })
  it('组字中的按键不触发区域快捷键', () => {
    expect(previewKeyAction({ ...base, key: 'a', ctrlKey: true, composing: true })).toBe('none')
    expect(
      previewKeyAction({ ...base, key: 'Escape', selectionInside: true, composing: true }),
    ).toBe('none')
  })
})

describe('组字中的 Escape', () => {
  it('浏览器给出任一信号都不退出编辑', () => {
    expect(composingBlocksEscape({ isComposing: true, keyCode: 27, composing: false })).toBe(true)
    expect(composingBlocksEscape({ isComposing: false, keyCode: 229, composing: false })).toBe(true)
    expect(composingBlocksEscape({ isComposing: false, keyCode: 27, composing: true })).toBe(true)
    expect(composingBlocksEscape({ isComposing: false, keyCode: 27, composing: false })).toBe(false)
  })
})
