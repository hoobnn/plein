import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const initialWidth of [639, 1440]) {
  test(`助手从 ${initialWidth} 宽度打开后随断点变化同步避让，草稿与焦点保留`, async ({ page }) => {
    await page.setViewportSize({ width: initialWidth, height: 900 })
    await newProject(page)
    await page.getByRole('button', { name: '打开助手', exact: true }).click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    const input = panel.getByPlaceholder('让小满帮你做点什么…')
    await expect(input).toBeFocused()
    await input.fill('保留这段未发送的草稿')
    const right = () =>
      page.evaluate(
        () =>
          (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
            .insets.right,
      )
    for (const width of [640, 639, 1440, 600, 640]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(right).toBe(width >= 640 ? 424 : 0)
      await expect(panel).toBeVisible()
      await expect
        .poll(async () => Math.round((await panel.boundingBox())!.width))
        .toBe(width >= 640 ? 400 : width - 24)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('保留这段未发送的草稿')
    }
    await page.screenshot({ path: test.info().outputPath('agent-breakpoint.png') })
    await page.getByRole('button', { name: '收起助手', exact: true }).click()
    await expect.poll(right).toBe(0)
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(right).toBe(0)
    await expect(panel).toHaveCount(0)
  })
}
