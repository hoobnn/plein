import { expect, test } from './fixtures'
import { newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
// 窄屏按现有设计收起整条视图工具栏，使用仍可用的画布快捷键。
for (const [width, action] of [
  [1440, 'button'],
  [390, 'shortcut'],
] as const) {
  test(`${width}px ${action} 整理含锁定节点的嵌套组不会局部撑大，解锁后可整理与还原`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    await page.setViewportSize({ width, height: 900 })
    const ids = await page.evaluate(() => {
      const source = window.__plein.addNode({
        type: 'plein/image',
        name: '嵌套来源',
        params: {},
        x: 400,
        y: 300,
      })
      const target = window.__plein.addNode({
        type: 'plein/image-process',
        name: '嵌套目标',
        params: {},
        x: 400,
        y: 300,
      })
      if (!window.__plein.connect([source, 'images'], [target, 'image']))
        throw new Error('连接失败')
      const engine = window.__plein.engine as unknown as Engine
      engine.selection.set([source, target])
      engine.groupSelection()
      const inner = engine.selection.values()[0]!
      const fixed = window.__plein.addNode({
        type: 'plein/text',
        name: '锁定的同级节点',
        params: { text: '保留原位' },
        x: 1000,
        y: 300,
      })
      engine.selection.set([inner, fixed])
      engine.groupSelection()
      const outer = engine.selection.values()[0]!
      engine.doc.ydoc.transact(
        () => engine.doc.mutable(fixed)!.set('locked', true),
        engine.doc.origin,
      )
      engine.selection.clear()
      engine.doc.flush()
      engine.doc.undo.stopCapturing()
      engine.zoomToFit()
      return { source, target, inner, fixed, outer }
    })
    const read = () =>
      page.evaluate(() => {
        const engine = window.__plein.engine as unknown as Engine
        return { nodes: [...engine.doc.elements()], edges: [...engine.doc.edges()] }
      })
    const arrange = async () => {
      if (action === 'button')
        await page.getByRole('button', { name: '整理画布', exact: true }).click()
      else {
        await page.mouse.click(width - 40, 700)
        await page.keyboard.press('Alt+Shift+f')
      }
    }
    const before = await read()
    await arrange()
    expect(await read()).toEqual(before)
    await page.screenshot({ path: testInfo.outputPath('locked-preserved.png') })
    await page.evaluate((id) => {
      const engine = window.__plein.engine as unknown as Engine
      engine.doc.ydoc.transact(
        () => engine.doc.mutable(id)!.set('locked', false),
        engine.doc.origin,
      )
      engine.doc.flush()
      engine.doc.undo.stopCapturing()
    }, ids.fixed)
    const unlocked = await read()
    await arrange()
    await expect.poll(read).not.toEqual(unlocked)
    const arranged = await read()
    expect(arranged.edges).toEqual(before.edges)
    const containment = await page.evaluate((id) => {
      const engine = window.__plein.engine as unknown as Engine
      return engine.doc.descendants(id).every((el) => {
        const r = engine.doc.worldRect(el.id)!
        const parent = engine.doc.worldRect(el.parentId!)!
        return (
          r.x >= parent.x &&
          r.y >= parent.y &&
          r.x + r.w <= parent.x + parent.w &&
          r.y + r.h <= parent.y + parent.h
        )
      })
    }, ids.outer)
    expect(containment).toBe(true)
    await page.getByRole('button', { name: '还原', exact: true }).click()
    await expect.poll(read).toEqual(unlocked)
    if (width < 640) await page.keyboard.press('ControlOrMeta+Shift+z')
    else await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(read).toEqual(arranged)
    if (width < 640) await page.keyboard.press('ControlOrMeta+z')
    else await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(read).toEqual(unlocked)
    await arrange()
    await page.getByRole('button', { name: '保留', exact: true }).click()
    await expect.poll(read).toEqual(arranged)
    await page.screenshot({ path: testInfo.outputPath('unlocked-arranged.png') })
    expect(errors).toEqual([])
  })
}
