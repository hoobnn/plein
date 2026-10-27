import { createElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { expect, it } from 'vite-plus/test'
import { Camera } from './camera'
import { SelectionOverlay } from './overlay'
import { Scene } from './scene'
import { Selection } from './selection'

it('只读画布隐藏已选节点的缩放手柄，恢复写权限后重新显示', () => {
  const doc = openDoc()
  const id = createElement(doc, node({ x: 100, y: 100, w: 200, h: 160 }))
  const selection = new Selection()
  const overlay = new SelectionOverlay(new Scene(doc), selection, new Camera())
  try {
    selection.set([id])
    expect(overlay.selectionBox()).toEqual({ x: 100, y: 100, w: 200, h: 160 })
    expect(overlay.showHandles()).toBe(true)
    doc.readOnly = true
    expect(overlay.showHandles()).toBe(false)
    doc.readOnly = false
    expect(overlay.showHandles()).toBe(true)
  } finally {
    overlay.destroy()
    doc.destroy()
  }
})
