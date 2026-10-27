import { expect, test } from './fixtures'
import { elements, newProject, settle, waitEngine } from './canvas'

for (const { top, zoom } of [
  { top: 120, zoom: 1 },
  { top: -240, zoom: 1 },
  { top: 120, zoom: 1.5 },
]) {
  test(`长便签从顶部 ${top}、缩放 ${zoom} 进入后，首尾光标与追加正文保持可见`, async ({ page }) => {
    await newProject(page)
    const text = [
      '长便签首行',
      ...Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：保留原始正文。`),
      '长便签结尾',
    ].join('\n')
    await page
      .locator('canvas')
      .first()
      .evaluate((canvas, text) => {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        canvas.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
        )
      }, text)
    await expect
      .poll(async () => (await elements(page)).filter((e) => e.kind === 'markdown').length)
      .toBe(1)
    const id = (await elements(page)).find((e) => e.kind === 'markdown')!.id
    await page.evaluate(
      ({ id, top, zoom }) => {
        const e = window.__plein.engine as Window['__plein']['engine'] & {
          zoomTo(level: number): void
          camera: { panBy(x: number, y: number): void }
        }
        e.zoomTo(zoom)
        const r = e.doc.worldRect(id)
        const p = e.worldToClient(r.x, r.y)
        e.camera.panBy(500 - p.x, top - p.y)
      },
      { id, top, zoom },
    )
    await settle(page, id)
    await page.mouse.dblclick(550, Math.max(120, top + 25))
    const editor = page.locator('.plein-md-editor .cm-content')
    const caret = page.locator('.plein-md-editor .cm-cursor')
    await expect(editor).toBeFocused()
    const camera = () =>
      page.evaluate(() => {
        const c = (
          window.__plein.engine as unknown as { camera: { x: number; y: number; zoom: number } }
        ).camera
        return { x: c.x, y: c.y, zoom: c.zoom }
      })
    const before = await camera()
    await editor.press('ControlOrMeta+End')
    await page.keyboard.insertText('，末尾追加')
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.__plein.engine.doc.getText(id)?.toString().endsWith('长便签结尾，末尾追加'),
          id,
        ),
      )
      .toBe(true)
    await expect(caret).toBeInViewport({ ratio: 0.999 })
    await editor.press('ControlOrMeta+Home')
    await expect(caret).toBeInViewport({ ratio: 0.999 })
    await page.keyboard.insertText('首行追加，')
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.__plein.engine.doc.getText(id)?.toString().startsWith('首行追加，长便签首行'),
          id,
        ),
      )
      .toBe(true)
    await page.screenshot({ path: test.info().outputPath(`markdown-long-edit-${top}.png`) })
    const scroller = page.locator('.plein-md-editor .cm-scroller')
    const box = (await scroller.boundingBox())!
    expect(box.height).toBeLessThanOrEqual(900)
    expect(box.y).toBeGreaterThanOrEqual(64)
    expect(box.y + box.height).toBeLessThanOrEqual(836)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 320)
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.insertText('滚动后追加，')
    await expect(caret).toBeInViewport({ ratio: 0.999 })
    expect(await camera()).toEqual(before)
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.worldRect(id).h, id),
    ).toBeGreaterThan(1000)
    expect(
      await page.evaluate(() => document.querySelector('.plein-overlay')!.parentElement!.scrollTop),
    ).toBe(0)
    await editor.press('Escape')
    await expect(editor).toHaveCount(0)
    expect((await elements(page)).map((e) => e.id)).toEqual([id])
    await page.mouse.dblclick(550, Math.max(120, top + 25))
    await expect(editor).toBeFocused()
    await editor.press('ControlOrMeta+End')
    await expect(caret).toBeInViewport({ ratio: 0.999 })
    const expected = `首行追加，滚动后追加，${text}，末尾追加`
    expect(await page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id)).toBe(
      expected,
    )
    await editor.press('Escape')
    await page.reload()
    await waitEngine(page)
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.getText(id)?.toString(), id))
      .toBe(expected)
  })
}
