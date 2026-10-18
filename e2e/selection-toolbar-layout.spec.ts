import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const width of [1440, 900, 390, 320]) {
  test(`${width}px 多选操作条避让面板，复制连线和打组可撤销重做`, async ({ page }) => {
    await newProject(page)
    await page.setViewportSize({ width, height: 900 })
    if (width === 1440) {
      const handle = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
      await handle.focus()
      for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')
      await expect(handle).toHaveAttribute('aria-valuenow', '480')
    }
    if (width >= 640) await page.getByRole('button', { name: '任务', exact: true }).click()
    const ids = await page.evaluate(() => {
      const a = window.__plein.addNode({
        type: 'plein/text',
        name: '多选甲',
        params: { text: '透明水杯' },
        x: 3000,
        y: 2000,
      })
      const b = window.__plein.addNode({
        type: 'plein/image',
        name: '多选乙',
        params: { model: 'plein/mock:image' },
        x: 3460,
        y: 2000,
      })
      window.__plein.connect([a, 'text'], [b, 'prompt'])
      window.__plein.engine.selection.set([a, b])
      window.__plein.engine.zoomToFit([a, b])
      return [a, b]
    })
    const bar = page.getByRole('toolbar', { name: '多选操作', exact: true })
    await expect(bar).toBeVisible()
    const fits = async () => {
      const box = (await bar.boundingBox())!
      const sidebar = page.getByRole('complementary', {
        name: '侧栏',
        exact: true,
        includeHidden: true,
      })
      const side = (await sidebar.boundingBox())!
      const left = (await sidebar.getAttribute('aria-hidden')) === 'true' ? 0 : side.x + side.width
      const tasks = page.getByRole('complementary', { name: '任务', exact: true })
      const right = await tasks.evaluateAll(
        (panels) => panels[0]?.getBoundingClientRect().x ?? window.innerWidth,
      )
      return box.x >= left + 4 && box.x + box.width <= right - 4 && box.y >= 64
    }
    await expect.poll(fits, { timeout: 1500 }).toBe(true)
    const hittable = () =>
      bar.locator('button:enabled').evaluateAll((buttons) =>
        buttons.every((button) => {
          const r = button.getBoundingClientRect()
          return (
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') ===
            button
          )
        }),
      )
    await expect.poll(hittable).toBe(true)
    await page.evaluate(() =>
      (
        window.__plein.engine.doc as unknown as { undo: { stopCapturing(): void } }
      ).undo.stopCapturing(),
    )
    await bar.getByRole('button', { name: '复制一份', exact: true }).click()
    const snapshot = () =>
      page.evaluate(() => ({
        elements: [...window.__plein.engine.doc.elements()].map((el) => ({
          id: el.id,
          parentId: el.parentId,
        })),
        edges: [...window.__plein.engine.doc.edges()],
        selection: window.__plein.engine.selection.values(),
      }))
    await expect.poll(async () => (await snapshot()).elements.length).toBe(4)
    const copied = await snapshot()
    expect(copied.edges).toHaveLength(2)
    expect(copied.selection).toHaveLength(2)
    expect(copied.selection.every((id) => !ids.includes(id))).toBe(true)
    expect(
      copied.edges.some(
        (edge) => copied.selection.includes(edge.from[0]) && copied.selection.includes(edge.to[0]),
      ),
    ).toBe(true)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await snapshot()).elements.length).toBe(2)
    expect((await snapshot()).edges).toHaveLength(1)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await snapshot()).elements.length).toBe(4)
    expect((await snapshot()).edges).toHaveLength(2)
    await page.evaluate((ids) => window.__plein.engine.selection.set(ids), ids)
    await bar.getByRole('button', { name: '打组', exact: true }).click()
    await expect.poll(async () => (await snapshot()).elements.length).toBe(5)
    const grouped = await snapshot()
    const frame = grouped.selection[0]!
    expect(ids.every((id) => grouped.elements.find((el) => el.id === id)?.parentId === frame)).toBe(
      true,
    )
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await snapshot()).elements.length).toBe(4)
    expect(
      (await snapshot()).elements
        .filter((el) => ids.includes(el.id))
        .every((el) => el.parentId === null),
    ).toBe(true)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await snapshot()).elements.length).toBe(5)
    expect((await snapshot()).edges).toHaveLength(2)
    await page.evaluate((ids) => {
      window.__plein.engine.selection.set(ids)
      window.__plein.engine.zoomToFit(ids)
    }, ids)
    await expect.poll(fits).toBe(true)
    await expect.poll(hittable).toBe(true)
    await page.screenshot({
      path: test.info().outputPath('selection-toolbar.png'),
      animations: 'disabled',
    })
    if (width >= 640) {
      await page
        .getByRole('complementary', { name: '任务', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await expect.poll(fits).toBe(true)
      await page.getByRole('button', { name: '任务', exact: true }).click()
      await expect.poll(fits).toBe(true)
      await expect.poll(hittable).toBe(true)
    }
  })
}
