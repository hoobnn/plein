import { expect, type Page, test } from '@playwright/test'
import { newProject, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine

async function setup(page: Page, redo = false) {
  await newProject(page)
  return page.evaluate((redo) => {
    const engine = window.__plein.engine as unknown as Engine
    const first = window.__plein.addNode({
      type: 'plein/text',
      name: '只读上游',
      params: { text: '不能丢失' },
      x: 500,
      y: 300,
    })
    const second = window.__plein.addNode({
      type: 'plein/image',
      name: '只读下游',
      params: {},
      x: 1000,
      y: 300,
    })
    window.__plein.connect([first, 'text'], [second, 'prompt'])
    engine.selection.set([first, second])
    engine.groupSelection()
    const frame = engine.selection.values()[0]!
    engine.doc.undo.clear()
    engine.nudge(11, 9)
    engine.doc.undo.stopCapturing()
    if (redo) engine.undo()
    engine.doc.flush()
    return { first, second, frame }
  }, redo)
}
const snapshot = (page: Page) =>
  page.evaluate(() => ({
    elements: [...window.__plein.engine.doc.elements()],
    edges: [...window.__plein.engine.doc.edges()],
  }))
async function readonly(page: Page, value: boolean) {
  await page.evaluate((value) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.doc.readOnly = value
    engine.refreshState()
    ;(document.activeElement as HTMLElement)?.blur()
  }, value)
}

const keys = {
  undo: 'ControlOrMeta+z',
  redo: 'ControlOrMeta+Shift+z',
  nudge: 'ArrowRight',
  delete: 'Backspace',
  duplicate: 'ControlOrMeta+d',
  group: 'ControlOrMeta+g',
  ungroup: 'ControlOrMeta+Shift+g',
  front: 'ControlOrMeta+]',
  back: 'ControlOrMeta+[',
} as const
for (const action of [...Object.keys(keys), 'paste', 'cut']) {
  test(`只读画布 ${action} 不写文档、不抛错，恢复可写后继续撤销重做`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const { frame } = await setup(page, action === 'redo')
    const before = await snapshot(page)
    await readonly(page, true)
    if (action in keys) await page.keyboard.press(keys[action as keyof typeof keys])
    else
      await page.evaluate((action) => {
        const engine = window.__plein.engine as unknown as Engine
        const data = new DataTransfer()
        if (action === 'paste') data.setData('text/plain', JSON.stringify(engine.copy()))
        document.body.dispatchEvent(
          new ClipboardEvent(action, { clipboardData: data, bubbles: true, cancelable: true }),
        )
        if (action === 'cut' && !JSON.parse(data.getData('text/plain')).plein)
          throw new Error('只读剪切仍应允许复制')
      }, action)
    expect(await snapshot(page)).toEqual(before)
    expect(errors).toEqual([])
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled()
    await readonly(page, false)
    const at = await page.evaluate((frame) => {
      const engine = window.__plein.engine as unknown as Engine
      const before = engine.doc.worldRect(frame)!
      engine.doc.undo.stopCapturing()
      engine.nudge(7, 5)
      engine.doc.undo.stopCapturing()
      engine.undo()
      engine.redo()
      return { before, after: engine.doc.worldRect(frame) }
    }, frame)
    expect(at.after).toMatchObject({ x: at.before.x + 7, y: at.before.y + 5 })
    expect(errors).toEqual([])
  })
}

for (const gesture of ['move', 'resize', 'connect'] as const) {
  for (const phase of ['initial', 'rendered', 'same-frame'] as const) {
    test(`只读 ${phase} 阻止 ${gesture} 手势，清除预览后仍可重新拖动和撤销`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const ids = await setup(page)
      await zoomTo(page, [ids.frame])
      const before = await snapshot(page)
      const world = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), ids.frame)
      const at = await page.evaluate(
        ({ ids, gesture }) => {
          const engine = window.__plein.engine as unknown as Engine
          const r = engine.doc.worldRect(gesture === 'connect' ? ids.second : ids.frame)!
          const p =
            gesture === 'connect'
              ? { x: r.x, y: r.y + r.h / 2 }
              : gesture === 'resize'
                ? { x: r.x + r.w, y: r.y + r.h }
                : { x: r.x + 90, y: r.y + 16 }
          return engine.worldToClient(p.x, p.y)
        },
        { ids, gesture },
      )
      const canvas = page.locator('canvas').first()
      await canvas.evaluate((el) =>
        el.addEventListener(
          'pointerdown',
          (e) => (el.dataset.pointerId = String((e as PointerEvent).pointerId)),
          {
            once: true,
          },
        ),
      )
      if (phase === 'initial') await readonly(page, true)
      await page.mouse.move(at.x, at.y)
      await page.mouse.down()
      await page.mouse.move(at.x - 45, at.y + 35, { steps: 4 })
      if (phase === 'rendered') await readonly(page, true)
      if (phase === 'same-frame') {
        await canvas.evaluate((el, at) => {
          const engine = window.__plein.engine as unknown as Engine
          engine.doc.readOnly = true
          el.dispatchEvent(
            new PointerEvent('pointerup', {
              pointerId: Number(el.dataset.pointerId),
              clientX: at.x - 45,
              clientY: at.y + 35,
              button: 0,
              bubbles: true,
            }),
          )
          engine.refreshState()
        }, at)
      }
      await page.mouse.up()
      expect(await snapshot(page)).toEqual(before)
      expect(
        await page.evaluate(
          (id) => (window.__plein.engine as unknown as Engine).scene.rect(id),
          ids.frame,
        ),
      ).toEqual(world)
      expect(errors).toEqual([])
      await expect(page.getByPlaceholder('添加节点')).toHaveCount(0)
      expect(
        await page.evaluate(() =>
          (
            window.__plein.engine as unknown as { overlay: { showHandles(): boolean } }
          ).overlay.showHandles(),
        ),
      ).toBe(false)
      if (gesture === 'resize' && phase === 'rendered')
        await page.screenshot({ path: test.info().outputPath('readonly-no-handles.png') })
      await readonly(page, false)
      const start = await page.evaluate((id) => {
        const engine = window.__plein.engine as unknown as Engine
        engine.selection.set([id])
        const r = engine.doc.worldRect(id)!
        return engine.worldToClient(r.x + 90, r.y + 16)
      }, ids.frame)
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 63, start.y + 24, { steps: 5 })
      await page.mouse.up()
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), ids.frame),
      ).not.toEqual(world)
      await page.evaluate(() => (window.__plein.engine as unknown as Engine).undo())
      expect(await snapshot(page)).toEqual(before)
      expect(errors).toEqual([])
    })
  }
}

test('只读右键菜单停用写入，保留定位和全选，不再打开创建菜单', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { frame } = await setup(page)
  await zoomTo(page, [frame])
  const before = await snapshot(page)
  await readonly(page, true)
  await expect(page.getByRole('button', { name: '添加节点', exact: true })).toBeDisabled()
  const at = await page.evaluate((id) => {
    const engine = window.__plein.engine as unknown as Engine
    const r = engine.doc.worldRect(id)!
    return engine.worldToClient(r.x + 90, r.y + 16)
  }, frame)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const menu = page.getByRole('menu')
  for (const label of ['复制一份', '打组', '解组', '置于顶层', '置于底层', '删除'])
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: /^缩放到选中/ })).toBeEnabled()
  await menu.screenshot({
    path: test.info().outputPath('readonly-context-menu.png'),
    animations: 'disabled',
  })
  await menu.getByRole('menuitem', { name: /^缩放到选中/ }).click()
  await page.keyboard.press('Tab')
  await expect(page.getByPlaceholder('添加节点')).toHaveCount(0)
  await page.mouse.dblclick(at.x, at.y)
  await expect(page.getByPlaceholder('添加节点')).toHaveCount(0)
  expect(await snapshot(page)).toEqual(before)
  expect(errors).toEqual([])
})

for (const entry of ['canvas', 'toolbar'] as const) {
  test(`创建菜单 ${entry} 打开后同帧变只读，旧 Enter 不创建节点且菜单退出`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await setup(page)
    const before = await snapshot(page)
    if (entry === 'canvas') await page.keyboard.press('Tab')
    else await page.getByRole('button', { name: '添加节点', exact: true }).click()
    const input = page.getByPlaceholder('添加节点')
    await input.fill('文本')
    await input.evaluate((el) => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.readOnly = true
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      )
      engine.refreshState()
    })
    await expect(input).toHaveCount(0)
    expect(await snapshot(page)).toEqual(before)
    expect(errors).toEqual([])
  })
}

test('整理后变为只读，迟到的还原操作不能绕过撤销保护', async ({ page }) => {
  await setup(page)
  const state = await page.evaluate(() => {
    const engine = window.__plein.engine as unknown as Engine
    const result = engine.arrange()
    if (!result) throw new Error('未产生整理操作')
    const before = [...engine.doc.elements()]
    engine.doc.readOnly = true
    engine.refreshState()
    return { reverted: result.revert(), before, after: [...engine.doc.elements()] }
  })
  expect(state.reverted).toBe(false)
  expect(state.after).toEqual(state.before)
})

test('只读画布仍可框选整组、复制完整层级与连线、平移和缩放', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { frame } = await setup(page)
  await zoomTo(page, [frame])
  await readonly(page, true)
  const before = await snapshot(page)
  const points = await page.evaluate((id) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.selection.clear()
    const r = engine.doc.worldRect(id)!
    return {
      from: engine.worldToClient(r.x - 20, r.y - 20),
      to: engine.worldToClient(r.x + r.w + 20, r.y + r.h + 20),
    }
  }, frame)
  await page.mouse.move(points.from.x, points.from.y)
  await page.mouse.down()
  await page.mouse.move(points.to.x, points.to.y, { steps: 5 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([frame])
  const copied = await page.evaluate(() => {
    const data = new DataTransfer()
    document.body.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    return JSON.parse(
      data.getData('text/plain'),
    ) as import('../packages/doc/src/clipboard').ClipboardData
  })
  expect(copied.elements).toHaveLength(3)
  expect(copied.edges).toHaveLength(1)
  expect(copied.elements.filter((el) => el.parentId === null)).toHaveLength(1)
  const camera = () =>
    page.evaluate(() => {
      const engine = window.__plein.engine as unknown as Engine
      return { x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom }
    })
  const start = await camera()
  await page.mouse.move(800, 500)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(860, 540, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  expect(await camera()).not.toEqual(start)
  await page.keyboard.press('ControlOrMeta+=')
  await expect.poll(async () => (await camera()).zoom).not.toBe(start.zoom)
  expect(await snapshot(page)).toEqual(before)
  expect(errors).toEqual([])
})
