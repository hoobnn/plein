import { connect, createElement, removeEdges, setParam, updateElement } from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import { afterEach, expect, it } from 'vite-plus/test'
import { FakeHost, initEngine, pointerEvent } from './testing'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup() {
  const doc = openDoc()
  const a = createElement(doc, node({ x: 100, y: 100, w: 200, h: 160, params: { text: '正文' } }))
  const b = createElement(doc, node({ x: 700, y: 100, w: 200, h: 160 }))
  const c = createElement(doc, node({ x: 700, y: 500, w: 200, h: 160 }))
  doc.flush()
  const f = await initEngine(doc)
  cleanups.push(() => doc.destroy(), f.cleanup)
  f.engine.selection.set([a])
  doc.undo.clear()
  const point = (id: string, side: 'center' | 'in' | 'out' | 'resize' = 'center') => {
    const r = doc.worldRect(id)!
    return f.engine.camera.worldToScreen(
      r.x + (side === 'in' ? 0 : side === 'out' || side === 'resize' ? r.w : r.w / 2),
      r.y + (side === 'resize' ? r.h : r.h / 2),
    )
  }
  const pointer = (type: string, at: { x: number; y: number }, extra = {}) => {
    const props = { clientX: at.x, clientY: at.y, altKey: true, ...extra }
    if (type === 'pointerdown') f.host.dispatchEvent(pointerEvent('pointermove', props))
    return f.host.dispatchEvent(pointerEvent(type, props))
  }
  const start = (side: 'center' | 'resize' = 'center') => {
    const p = point(a, side)
    pointer('pointerdown', p)
    pointer('pointermove', { x: p.x + 40, y: p.y + 30 })
    return p
  }
  const snapshot = () => ({ elements: [...doc.elements()], edges: [...doc.edges()] })
  return { ...f, doc, a, b, c, point, pointer, start, snapshot }
}

it.each(['pointercancel', 'lostpointercapture', 'blur', 'Escape'] as const)(
  '%s 取消位置预览、不写历史；下一次移动仍能提交和撤销',
  async (cancel) => {
    const f = await setup()
    const before = f.snapshot()
    const rect = f.doc.worldRect(f.a)
    const p = f.start()
    expect(f.engine.scene.rect(f.a)).not.toEqual(rect)
    expect(f.snapshot()).toEqual(before)
    if (cancel === 'blur') window.dispatchEvent(new Event('blur'))
    else if (cancel === 'Escape') window.dispatchEvent(pointerEvent('keydown', { key: 'Escape' }))
    else f.pointer(cancel, p)
    expect(f.engine.scene.rect(f.a)).toEqual(rect)
    f.pointer('pointerup', { x: p.x + 100, y: p.y + 100 })
    expect(f.snapshot()).toEqual(before)
    expect(f.doc.undo.undoStack).toHaveLength(0)
    f.start()
    f.pointer('pointerup', { x: p.x + 40, y: p.y + 30 })
    expect(f.doc.worldRect(f.a)).toMatchObject({ x: 140, y: 130 })
    f.engine.undo()
    expect(f.snapshot()).toEqual(before)
  },
)

it('缩放取消恢复预览，提交、撤销重做保留正文', async () => {
  const f = await setup()
  const before = f.snapshot()
  const p = f.start('resize')
  f.pointer('pointercancel', p)
  expect(f.engine.scene.rect(f.a)).toEqual(f.doc.worldRect(f.a))
  f.start('resize')
  f.pointer('pointerup', { x: p.x + 40, y: p.y + 30 })
  expect(f.doc.get(f.a)).toMatchObject({ w: 240, h: 190, params: { text: '正文' } })
  const after = f.snapshot()
  f.engine.undo()
  expect(f.snapshot()).toEqual(before)
  f.engine.redo()
  expect(f.snapshot()).toEqual(after)
})

it('第二指针不能提交或取消第一指针的预览', async () => {
  const f = await setup()
  const p = f.start()
  const preview = f.engine.scene.rect(f.a)
  for (const type of ['pointermove', 'pointerup', 'pointercancel'])
    f.pointer(type, { x: 0, y: 0 }, { pointerId: 2 })
  expect(f.engine.scene.rect(f.a)).toEqual(preview)
  f.pointer('pointerup', p)
  expect(f.doc.worldRect(f.a)).toEqual(preview)
  expect(f.doc.undo.undoStack).toHaveLength(1)
})

it.each(['move', 'resize', 'delete', 'text', 'other', 'selection'] as const)(
  '拖动期间外部 %s 保留新内容，按受影响对象取消旧预览',
  async (change) => {
    const f = await setup()
    const rect = f.doc.worldRect(f.a)
    const p = f.start()
    f.doc.ydoc.transact(() => {
      if (change === 'move') updateElement(f.doc, f.a, { x: 450 })
      if (change === 'resize') updateElement(f.doc, f.a, { w: 280 })
      if (change === 'delete') f.doc.elementMaps.delete(f.a)
      if (change === 'text') setParam(f.doc, f.a, 'text', '同伴正文')
      if (change === 'other') updateElement(f.doc, f.b, { y: 450 })
    }, 'peer')
    if (change === 'selection') f.engine.selection.set([f.b])
    f.doc.flush()
    f.pointer('pointerup', { x: p.x + 40, y: p.y + 30 })
    if (change === 'delete') expect(f.doc.get(f.a)).toBeUndefined()
    else if (change === 'move') expect(f.doc.worldRect(f.a)?.x).toBe(450)
    else if (change === 'resize') expect(f.doc.worldRect(f.a)?.w).toBe(280)
    else if (change === 'selection') {
      expect(f.doc.worldRect(f.a)).toEqual(rect)
      expect(f.engine.selection.values()).toEqual([f.b])
    } else {
      expect(f.doc.worldRect(f.a)).toMatchObject({ x: 140, y: 130 })
      if (change === 'text') expect(f.doc.get(f.a)?.params?.text).toBe('同伴正文')
      else expect(f.doc.worldRect(f.b)?.y).toBe(450)
      f.engine.undo()
      expect(f.doc.worldRect(f.a)).toEqual(rect)
      if (change === 'text') expect(f.doc.get(f.a)?.params?.text).toBe('同伴正文')
    }
    f.doc.flush()
    expect(f.engine.scene.rect(f.a)).toEqual(f.doc.worldRect(f.a))
  },
)

it.each(
  ['initial', 'during', 'same-frame'].flatMap((phase) =>
    (['center', 'resize'] as const).map((side) => ({ phase, side })),
  ),
)('只读 $phase 阻止 $side 写入，恢复权限后下一次手势可提交和撤销', async ({ phase, side }) => {
  const f = await setup()
  const before = f.snapshot()
  if (phase === 'initial') f.doc.readOnly = true
  const p = f.start(side)
  if (phase !== 'initial') f.doc.readOnly = true
  if (phase !== 'same-frame') f.engine.refreshState()
  f.pointer('pointerup', { x: p.x + 40, y: p.y + 30 })
  expect(f.snapshot()).toEqual(before)
  expect(f.engine.scene.rect(f.a)).toEqual(f.doc.worldRect(f.a))
  expect(f.doc.undo.undoStack).toHaveLength(0)
  f.doc.readOnly = false
  const next = f.start(side)
  f.pointer('pointerup', { x: next.x + 40, y: next.y + 30 })
  expect(f.doc.worldRect(f.a)).toMatchObject(
    side === 'center' ? { x: 140, y: 130, w: 200, h: 160 } : { x: 100, y: 100, w: 240, h: 190 },
  )
  expect(f.doc.undo.undoStack).toHaveLength(1)
  f.engine.undo()
  expect(f.snapshot()).toEqual(before)
})

it.each([{ isComposing: true }, { keyCode: 229 }])(
  '组字 %j 不执行删除也不取消拖动',
  async (composition) => {
    const f = await setup()
    const before = f.snapshot()
    const deletion = pointerEvent('keydown', { key: 'Backspace', ...composition })
    window.dispatchEvent(deletion)
    expect(deletion.defaultPrevented).toBe(false)
    expect(f.snapshot()).toEqual(before)
    const p = f.start()
    const escape = pointerEvent('keydown', { key: 'Escape', ...composition })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
    f.pointer('pointerup', p)
    expect(f.snapshot()).not.toEqual(before)
    f.engine.undo()
    window.dispatchEvent(pointerEvent('keydown', { key: 'Backspace' }))
    expect(f.doc.has(f.a)).toBe(false)
    f.engine.undo()
    expect(f.snapshot()).toEqual(before)
  },
)

it.each(['cancel', 'wheel', 'zoom', 'readonly', 'deleted', 'reconnect', 'same', 'empty'] as const)(
  '拾起已有连线 %s 的确认边界和单步撤销',
  async (action) => {
    const f = await setup()
    connect(f.doc, [f.a, 'out'], [f.b, 'in'])
    f.doc.flush()
    f.doc.undo.clear()
    const before = f.snapshot()
    const p = f.point(f.b, 'in')
    f.pointer('pointerdown', p)
    f.pointer('pointermove', { x: p.x - 40, y: p.y + 30 })
    expect(f.snapshot()).toEqual(before)
    if (action === 'cancel') f.pointer('pointercancel', p)
    if (action === 'wheel' || action === 'zoom')
      f.host.dispatchEvent(
        pointerEvent('wheel', { deltaX: 2, deltaY: -3, deltaMode: 0, ctrlKey: action === 'zoom' }),
      )
    if (action === 'readonly') f.doc.readOnly = true
    if (action === 'deleted') {
      f.doc.ydoc.transact(() => removeEdges(f.doc, [before.edges[0]!.id]), 'peer')
      f.doc.flush()
    }
    f.pointer(
      'pointerup',
      action === 'same' ? p : action === 'empty' ? { x: 1100, y: 700 } : f.point(f.c, 'in'),
    )
    if (action === 'deleted' || action === 'empty') expect([...f.doc.edges()]).toEqual([])
    else if (action === 'reconnect')
      expect([...f.doc.edges()]).toMatchObject([{ from: [f.a, 'out'], to: [f.c, 'in'] }])
    else expect(f.snapshot()).toEqual(before)
    if (action === 'empty' || action === 'reconnect') {
      expect(f.doc.undo.undoStack).toHaveLength(1)
      const after = f.snapshot()
      f.engine.undo()
      expect(f.snapshot()).toEqual(before)
      f.engine.redo()
      expect(f.snapshot()).toEqual(after)
    } else expect(f.doc.undo.undoStack).toHaveLength(0)
    f.doc.readOnly = false
  },
)

it.each([0.249, 0.25].flatMap((zoom) => [0, 2].map((depth) => ({ zoom, depth }))))(
  '缩放 $zoom、$depth 层分组的端口显示与命中同步',
  async ({ zoom, depth }) => {
    const f = await setup()
    for (let i = 0; i < depth; i++) f.engine.groupSelection()
    f.doc.flush()
    f.engine.camera.zoomTo(zoom)
    f.engine.selection.clear()
    const p = f.point(f.a, 'out')
    f.pointer('pointerdown', { x: p.x - 1, y: p.y })
    f.pointer('pointermove', f.point(f.b, 'in'))
    f.pointer('pointerup', f.point(f.b, 'in'))
    if (zoom < 0.25) {
      expect([...f.doc.edges()]).toEqual([])
      expect(f.doc.worldRect(f.a)?.x).not.toBe(100)
    } else expect([...f.doc.edges()]).toMatchObject([{ from: [f.a, 'out'], to: [f.b, 'in'] }])
    f.engine.undo()
    expect([...f.doc.edges()]).toEqual([])
    expect(f.doc.worldRect(f.a)?.x).toBe(100)
  },
)

it('被挡住的端口中心不能抢走邻近卡片拖动，移开遮挡后可重新连接', async () => {
  const f = await setup()
  const cover = createElement(f.doc, box({ x: 296, y: 160, w: 80, h: 40 }))
  f.doc.flush()
  f.engine.camera.zoomTo(0.5)
  f.engine.selection.clear()
  const p = f.point(f.a, 'out')
  f.pointer('pointerdown', { x: p.x - 8, y: p.y })
  f.pointer('pointermove', { x: p.x - 48, y: p.y + 20 })
  f.pointer('pointerup', { x: p.x - 48, y: p.y + 20 })
  expect([...f.doc.edges()]).toEqual([])
  expect(f.doc.worldRect(f.a)?.x).not.toBe(100)
  f.engine.undo()
  updateElement(f.doc, cover, { y: 0 })
  f.doc.flush()
  f.engine.selection.clear()
  f.pointer('pointerdown', f.point(f.a, 'out'))
  f.pointer('pointermove', f.point(f.b, 'in'))
  f.pointer('pointerup', f.point(f.b, 'in'))
  expect([...f.doc.edges()]).toMatchObject([{ from: [f.a, 'out'], to: [f.b, 'in'] }])
})

it.each(['blur', 'selection', 'peer'] as const)(
  '框选中 %s 按最新上下文恢复或确定选区',
  async (action) => {
    const f = await setup()
    const from = { x: 80, y: 80 },
      to = { x: 320, y: 280 }
    f.pointer('pointerdown', from)
    f.pointer('pointermove', to)
    expect(f.engine.selection.values()).toEqual([f.a])
    if (action === 'blur') window.dispatchEvent(new Event('blur'))
    if (action === 'selection') f.engine.selection.set([f.b])
    if (action === 'peer') {
      f.doc.ydoc.transact(() => updateElement(f.doc, f.a, { y: 900 }), 'peer')
      f.doc.flush()
    }
    f.pointer('pointerup', to)
    expect(f.engine.selection.values()).toEqual(
      action === 'selection' ? [f.b] : action === 'blur' ? [f.a] : [],
    )
  },
)

it.each(['pointercancel', 'wheel', 'readonly'] as const)(
  '新连线被 %s 取消后不写文档，恢复后可重新连接',
  async (action) => {
    const f = await setup()
    const before = f.snapshot()
    f.pointer('pointerdown', f.point(f.a, 'out'))
    f.pointer('pointermove', { x: 1100, y: 700 })
    if (action === 'pointercancel') f.pointer('pointercancel', { x: 1100, y: 700 })
    if (action === 'wheel')
      f.host.dispatchEvent(pointerEvent('wheel', { deltaX: 3, deltaY: 4, deltaMode: 0 }))
    if (action === 'readonly') f.doc.readOnly = true
    f.pointer('pointerup', f.point(f.b, 'in'))
    expect(f.snapshot()).toEqual(before)
    f.doc.readOnly = false
    f.pointer('pointerdown', f.point(f.a, 'out'))
    f.pointer('pointermove', f.point(f.b, 'in'))
    f.pointer('pointerup', f.point(f.b, 'in'))
    expect([...f.doc.edges()]).toMatchObject([{ from: [f.a, 'out'], to: [f.b, 'in'] }])
  },
)

it('右键拖动只接管镜头不改选区，轻点未选中卡片才选择目标', async () => {
  const f = await setup()
  const before = f.snapshot()
  const p = f.point(f.b)
  f.pointer('pointerdown', p, { button: 2, timeStamp: 1000 })
  f.pointer('pointermove', { x: p.x + 120, y: p.y - 60 }, { button: 2, timeStamp: 1016 })
  f.pointer('pointerup', { x: p.x + 120, y: p.y - 60 }, { button: 2, timeStamp: 1200 })
  expect(f.engine.selection.values()).toEqual([f.a])
  expect(f.snapshot()).toEqual(before)
  expect(f.engine.camera.x).toBe(120)
  expect(f.engine.camera.y).toBe(-60)
  f.pointer('pointerdown', f.point(f.b), { button: 2 })
  f.pointer('pointerup', f.point(f.b), { button: 2 })
  expect(f.engine.selection.values()).toEqual([f.b])
  expect(f.snapshot()).toEqual(before)
})

it.each(['cut', 'paste'] as const)(
  '只读 %s 原生事件不写入，复制仍保留分组层级与连线',
  async (action) => {
    const f = await setup()
    connect(f.doc, [f.a, 'out'], [f.b, 'in'])
    f.engine.selection.set([f.a, f.b])
    f.engine.groupSelection()
    const before = f.snapshot()
    f.doc.readOnly = true
    const data = new Map<string, string>()
    const clipboardData = {
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? '',
    }
    window.dispatchEvent(pointerEvent('copy', { clipboardData }))
    const copied = JSON.parse(data.get('text/plain')!)
    expect(copied.elements).toHaveLength(3)
    expect(copied.edges).toHaveLength(1)
    expect(
      copied.elements.filter((el: { parentId: string | null }) => el.parentId === null),
    ).toHaveLength(1)
    window.dispatchEvent(pointerEvent(action, { clipboardData }))
    expect(f.snapshot()).toEqual(before)
    f.doc.readOnly = false
    window.dispatchEvent(pointerEvent('paste', { clipboardData }))
    expect([...f.doc.elements()]).toHaveLength(7)
  },
)

it('千元素场景双层分组和移动只改变选中成员的世界位置，撤销重做保留素材', async () => {
  const f = await setup()
  const ids = Array.from({ length: 1000 }, (_, i) =>
    createElement(
      f.doc,
      box({ assetId: `asset-${i % 32}`, x: (i % 40) * 160, y: Math.floor(i / 40) * 130 }),
    ),
  )
  f.doc.flush()
  const original = ids.map((id) => ({ element: f.doc.get(id), rect: f.doc.worldRect(id)! }))
  const selected = ids.slice(0, 12)
  f.engine.selection.set(selected)
  f.engine.groupSelection()
  f.engine.groupSelection()
  f.doc.flush()
  expect(ids.map((id) => f.doc.worldRect(id))).toEqual(original.map((entry) => entry.rect))
  const grouped = f.snapshot()
  f.engine.nudge(80, 45)
  const moved = f.snapshot()
  for (const [i, id] of ids.entries()) {
    const before = original[i]!
    expect(f.doc.worldRect(id)).toEqual(
      i < 12 ? { ...before.rect, x: before.rect.x + 80, y: before.rect.y + 45 } : before.rect,
    )
    expect(f.doc.get(id)?.assetId).toBe(before.element?.assetId)
  }
  f.engine.undo()
  expect(f.snapshot()).toEqual(grouped)
  f.engine.redo()
  expect(f.snapshot()).toEqual(moved)
})

it('分组左上角缩放取消恢复全部预览，提交和撤销保留子节点世界坐标', async () => {
  const f = await setup()
  f.engine.selection.set([f.a, f.b])
  f.engine.groupSelection()
  f.doc.flush()
  const frame = f.engine.selection.values()[0]!
  const before = f.snapshot()
  const childRects = [f.doc.worldRect(f.a), f.doc.worldRect(f.b)]
  const rect = f.doc.worldRect(frame)!
  const at = f.engine.camera.worldToScreen(rect.x, rect.y)
  const resize = () => {
    f.pointer('pointerdown', at)
    f.pointer('pointermove', { x: at.x - 50, y: at.y - 35 })
  }
  resize()
  expect(f.engine.scene.rect(frame)).not.toEqual(rect)
  f.pointer('pointercancel', at)
  expect(f.snapshot()).toEqual(before)
  expect([f.engine.scene.rect(f.a), f.engine.scene.rect(f.b)]).toEqual(childRects)
  resize()
  f.pointer('pointerup', { x: at.x - 50, y: at.y - 35 })
  expect(f.doc.worldRect(frame)).not.toEqual(rect)
  expect([f.doc.worldRect(f.a), f.doc.worldRect(f.b)]).toEqual(childRects)
  f.engine.undo()
  expect(f.snapshot()).toEqual(before)
})

it.each(['dialog', 'menu', 'listbox'] as const)(
  '%s 内快捷键和剪贴板不穿透背后画布',
  async (role) => {
    const f = await setup()
    const target = new FakeHost()
    Object.defineProperty(target, 'closest', {
      value: (selector: string) => (selector.includes(`[role="${role}"]`) ? target : null),
    })
    const before = f.snapshot()
    for (const props of [
      { key: 'Backspace' },
      { key: 'Delete' },
      { key: 'd', ctrlKey: true },
      { key: 'z', ctrlKey: true },
      { key: ' ', code: 'Space' },
      { key: 'Tab' },
    ]) {
      const event = pointerEvent('keydown', { ...props, target })
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(f.snapshot()).toEqual(before)
    }
    const original = JSON.stringify(f.engine.copy())
    let text = original
    const clipboardData = {
      setData: (_key: string, value: string) => {
        text = value
      },
      getData: () => text,
    }
    for (const action of ['copy', 'cut', 'paste']) {
      const event = pointerEvent(action, { target, clipboardData })
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(text).toBe(original)
      expect(f.snapshot()).toEqual(before)
    }
  },
)

it.each(['Tab', 'dblclick'] as const)(
  '只读画布 %s 不打开创建菜单，恢复权限后可打开',
  async (action) => {
    const f = await setup()
    let menus = 0
    f.engine.onMenu(() => menus++)
    const open = () => {
      if (action === 'Tab') window.dispatchEvent(pointerEvent('keydown', { key: 'Tab' }))
      else f.host.dispatchEvent(pointerEvent('dblclick', { clientX: 1100, clientY: 700 }))
    }
    f.doc.readOnly = true
    open()
    expect(menus).toBe(0)
    f.doc.readOnly = false
    open()
    expect(menus).toBe(1)
  },
)

it('聚焦按钮保留 Tab 和空格，普通画布 Tab 仍能打开创建菜单', async () => {
  const f = await setup()
  const target = new FakeHost()
  Object.defineProperty(target, 'closest', {
    value: (selector: string) => (selector.includes('button,') ? target : null),
  })
  let menus = 0
  f.engine.onMenu(() => menus++)
  for (const props of [{ key: 'Tab' }, { key: ' ', code: 'Space' }]) {
    const event = pointerEvent('keydown', { ...props, target })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  const before = f.engine.camera.x
  f.pointer('pointerdown', { x: 1100, y: 700 })
  f.pointer('pointermove', { x: 1150, y: 750 })
  f.pointer('pointerup', { x: 1150, y: 750 })
  expect(f.engine.camera.x).toBe(before)
  expect(menus).toBe(0)
  window.dispatchEvent(pointerEvent('keydown', { key: 'Tab' }))
  expect(menus).toBe(1)
})
