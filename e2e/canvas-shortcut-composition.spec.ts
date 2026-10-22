import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
const snapshot = (page: Page) => page.evaluate(() => [...window.__plein.engine.doc.elements()])
async function setup(page: Page) {
  await newProject(page)
  return page.evaluate(() => {
    const engine = window.__plein.engine as unknown as Engine
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '组字快捷键保护',
      params: { text: '保留正文' },
      x: 600,
      y: 300,
    })
    engine.selection.set([id])
    engine.doc.undo.clear()
    engine.nudge(11, 7)
    engine.doc.undo.stopCapturing()
    return id
  })
}
for (const mode of ['legacy229', 'composition'] as const) {
  for (const action of ['delete'] as const) {
    test(`画布 ${mode} 的 ${action} 不误执行，组字结束后正常快捷键仍可用`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await setup(page)
      const before = await snapshot(page)
      const accepted = await page
        .locator('canvas')
        .first()
        .evaluate(
          (el, { mode }) =>
            el.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Backspace',
                code: 'Backspace',
                metaKey: false,
                isComposing: mode === 'composition',
                keyCode: mode === 'legacy229' ? 229 : 0,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { mode },
        )
      expect(await snapshot(page)).toEqual(before)
      expect(accepted).toBe(true)
      await page.keyboard.press('Backspace')
      expect(await snapshot(page)).not.toEqual(before)
      await page.keyboard.press('ControlOrMeta+z')
      expect(await snapshot(page)).toEqual(before)
      expect(errors).toEqual([])
    })
  }
  test(`拖动中的 ${mode} Esc 不取消手势，普通 Esc 仍可取消`, async ({ page }) => {
    const id = await setup(page)
    await zoomTo(page, [id])
    const before = await snapshot(page)
    const at = await centerOf(page, id)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 80, at.y + 40, { steps: 4 })
    const accepted = await page
      .locator('canvas')
      .first()
      .evaluate(
        (el, mode) =>
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              code: 'Escape',
              isComposing: mode === 'composition',
              keyCode: mode === 'legacy229' ? 229 : 27,
              bubbles: true,
              cancelable: true,
            }),
          ),
        mode,
      )
    expect(accepted).toBe(true)
    await page.mouse.up()
    expect(await snapshot(page)).not.toEqual(before)
    await page.keyboard.press('ControlOrMeta+z')
    expect(await snapshot(page)).toEqual(before)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.mouse.move(at.x + 70, at.y + 30, { steps: 4 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await snapshot(page)).toEqual(before)
  })
}
