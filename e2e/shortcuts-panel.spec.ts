import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const list: string[] = []
  errors.set(page, list)
  page.on('pageerror', (error) => list.push(error.message))
})
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]))
for (const viewport of [
  { width: 320, height: 600 },
  { width: 700, height: 600 },
  { width: 1440, height: 700 },
]) {
  test(`${viewport.width}px 快捷键说明无文字裁切，实际滚动可达最后一项并恢复焦点`, async ({
    page,
  }, testInfo) => {
    await newProject(page)
    await page.setViewportSize(viewport)
    const trigger = page.getByRole('button', { name: '快捷键', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '快捷键', exact: true })
    await expect(dialog).toBeVisible()
    const body = dialog.locator('section').first().locator('..')
    await expect
      .poll(() =>
        dialog
          .locator('li > span:first-child')
          .evaluateAll((labels) =>
            labels.every((el) => el.scrollWidth <= el.clientWidth && el.clientWidth > 0),
          ),
      )
      .toBe(true)
    const rect = (await body.boundingBox())!
    const panel = (await dialog.boundingBox())!
    await page.mouse.move(
      panel.x + panel.width / 2,
      Math.min(rect.y + 50, panel.y + panel.height - 30),
    )
    await page.mouse.wheel(0, 2000)
    const last = dialog.getByText('快捷键面板', { exact: true })
    await expect
      .poll(
        () =>
          last.evaluate((el) => {
            const r = el.getBoundingClientRect()
            const body = el.closest('section')!.parentElement!.getBoundingClientRect()
            const dialog = el.closest('[role="dialog"]')!.getBoundingClientRect()
            return (
              r.top >= Math.max(body.top, dialog.top) &&
              r.bottom <= Math.min(body.bottom, dialog.bottom) &&
              r.bottom <= window.innerHeight
            )
          }),
        { timeout: 1500 },
      )
      .toBe(true)
    await page.screenshot({
      path: testInfo.outputPath('shortcuts-scrolled.png'),
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '关闭', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
}
for (const mode of ['composition', 'legacy229', 'consumed', 'repeat', 'ctrl', 'meta', 'alt']) {
  test(`画布 ${mode} 问号不误开说明，正常问号仍可打开`, async ({ page }) => {
    await newProject(page)
    const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
    const accepted = await page
      .locator('canvas')
      .first()
      .evaluate((el, mode) => {
        if (mode === 'consumed')
          el.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
        return el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '?',
            code: 'Slash',
            shiftKey: true,
            isComposing: mode === 'composition',
            keyCode: mode === 'legacy229' ? 229 : 0,
            repeat: mode === 'repeat',
            ctrlKey: mode === 'ctrl',
            metaKey: mode === 'meta',
            altKey: mode === 'alt',
            bubbles: true,
            cancelable: true,
          }),
        )
      }, mode)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const dialog = page.getByRole('dialog', { name: '快捷键', exact: true })
    await expect(dialog).toHaveCount(0, { timeout: 1500 })
    expect(accepted).toBe(mode !== 'consumed')
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
    await page.keyboard.press('?')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}
