import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const height of [900, 320]) {
  test(`分组长菜单在 ${height}px 高视口内完整显示，键盘和点击均可解组`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height })
    await newProject(page)
    const point = { x: 950, y: height - 90 }
    await page.evaluate((point) => {
      const first = window.__plein.addNode({
        type: 'plein/text',
        name: '边缘节点',
        params: {},
        x: 400,
        y: 200,
      })
      const engine = window.__plein.engine as Window['__plein']['engine'] & {
        groupSelection(): void
        doc: { flush(): void }
        camera: { panBy(x: number, y: number): void }
      }
      engine.selection.set([first])
      engine.groupSelection()
      engine.doc.flush()
      const frame = [...engine.doc.elements()].find((el) => el.kind === 'frame')!
      const rect = engine.doc.worldRect(frame.id)
      const current = engine.worldToClient(rect.x + 80, rect.y + 16)
      engine.camera.panBy(point.x - current.x, point.y - current.y)
    }, point)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu).toHaveCSS('opacity', '1')
    const box = await menu.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(8)
    expect(box!.y).toBeGreaterThanOrEqual(8)
    expect(box!.x + box!.width).toBeLessThanOrEqual(992)
    expect(box!.y + box!.height).toBeLessThanOrEqual(height - 8)
    if (height === 900) {
      await page.setViewportSize({ width: 1000, height: 320 })
      await expect
        .poll(async () => {
          const resized = await menu.boundingBox()
          return resized ? resized.y + resized.height : Infinity
        })
        .toBeLessThanOrEqual(312)
      await page.setViewportSize({ width: 1000, height })
      await expect.poll(async () => (await menu.boundingBox())?.y).toBeGreaterThan(8)
    } else {
      await menu.hover()
      await page.mouse.wheel(0, 180)
      await expect(menu).toBeVisible()
      await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    }
    await page.keyboard.press('End')
    const last = menu.getByRole('menuitem').last()
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport({ ratio: 1 })
    await last.click({ trial: true, timeout: 1500 })
    const lastBox = await last.boundingBox()
    await last.click({ trial: true, position: { x: lastBox!.width - 8, y: lastBox!.height / 2 } })
    await page.screenshot({ path: `test-results/context-menu-${height}.png` })
    await page.keyboard.press('Home')
    await expect(menu.getByRole('menuitem').first()).toBeInViewport({ ratio: 1 })
    await menu.getByRole('menuitem', { name: /^解组/ }).click()
    await expect(menu).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'frame').length,
        ),
      )
      .toBe(0)
  })
}
