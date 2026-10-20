import { expect, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'
type Engine = import('../packages/canvas-core/src/engine').Engine

for (const width of [320, 390, 640, 664, 700, 800, 900, 1440]) {
  test(`${width}px 底栏所有按钮留在窗口内且不被助手遮挡`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    await page.setViewportSize({ width, height: 700 })
    if (width === 800 || width === 1440) {
      const resize = page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
      await resize.focus()
      for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight')
    }
    const footer = page.getByRole('contentinfo')
    await expect
      .poll(
        () =>
          footer.locator('button:visible').evaluateAll(
            (buttons) =>
              buttons.length > 0 &&
              buttons.every((button) => {
                const r = button.getBoundingClientRect()
                return (
                  r.left >= 0 &&
                  r.right <= window.innerWidth &&
                  r.top >= 64 &&
                  r.bottom <= window.innerHeight &&
                  ((button instanceof HTMLButtonElement && button.disabled) ||
                    document
                      .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                      ?.closest('button') === button)
                )
              }),
          ),
        { timeout: 2500 },
      )
      .toBe(true)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    const trigger = page.getByRole('button', { name: '快捷键', exact: true })
    await trigger.click()
    await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '快捷键', exact: true })).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('footer-fit.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })
}

test('分行底栏下文本生成器仍完整可编辑，正文保留', async ({ page }, testInfo) => {
  await newProject(page)
  await page.setViewportSize({ width: 700, height: 600 })
  await expect
    .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.width))
    .toBe(700)
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '底栏避让编辑',
      params: { text: '保留正文' },
      x: 500,
      y: 200,
    })
    const engine = window.__plein.engine as unknown as Engine
    engine.doc.flush()
    engine.zoomToFit([id])
    return id
  })
  await clickElement(page, id)
  const panel = page.getByTestId('generator')
  await expect(panel).toBeVisible()
  if ((await panel.getAttribute('data-compact')) === 'true')
    await panel.getByRole('button', { name: /^编辑/ }).click()
  const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
  await expect(prompt).toBeVisible()
  await expect
    .poll(() =>
      panel.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return (
          r.left >= 4 &&
          r.right <= window.innerWidth - 4 &&
          r.top >= 64 &&
          r.bottom <= window.innerHeight - 128
        )
      }),
    )
    .toBe(true)
  await prompt.fill('底栏分行后仍能编辑 🌧️')
  await prompt.press('Tab')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, id))
    .toBe('底栏分行后仍能编辑 🌧️')
  await page.screenshot({
    path: testInfo.outputPath('footer-generator.png'),
    animations: 'disabled',
  })
})
