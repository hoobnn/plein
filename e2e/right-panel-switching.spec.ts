import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const initialWidth of [639, 1440]) {
  test(`${initialWidth}px 助手与任务互相切换保留草稿，断点和主动展开侧栏正确释放边距`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: initialWidth, height: 900 })
    await newProject(page)
    const assistant = page.getByRole('complementary', { name: '助手', exact: true })
    const tasks = page.getByRole('complementary', { name: '任务', exact: true })
    const openTasks = page.getByRole('button', { name: '任务', exact: true })
    const openAgent = page.getByRole('button', { name: '打开助手', exact: true })
    const right = () =>
      page.evaluate(
        () =>
          (window.__plein.engine as unknown as { camera: { insets: { right: number } } }).camera
            .insets.right,
      )
    await openAgent.click()
    const input = assistant.getByPlaceholder('让小满帮你做点什么…')
    await expect(input).toBeFocused()
    await input.fill('切换面板时保留这份草稿')
    await openTasks.click()
    await expect(tasks).toBeVisible()
    await expect(assistant).toHaveCount(0)
    await expect.poll(right).toBe(initialWidth >= 640 ? 372 : 0)
    for (const width of [640, 639, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(right).toBe(width >= 640 ? 372 : 0)
      await expect
        .poll(async () => Math.round((await tasks.boundingBox())!.width))
        .toBe(width >= 640 ? 360 : width - 24)
    }
    await openAgent.click()
    await expect(tasks).toHaveCount(0)
    await expect(input).toHaveValue('切换面板时保留这份草稿')
    await expect.poll(right).toBe(424)
    await page.getByRole('button', { name: '收起助手', exact: true }).click()
    await expect.poll(right).toBe(0)
    await openTasks.click()
    await page.setViewportSize({ width: 900, height: 900 })
    const sidebar = page.getByRole('complementary', {
      name: '侧栏',
      exact: true,
      includeHidden: true,
    })
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    await expect(tasks).toHaveCount(0)
    await expect(sidebar).toHaveAttribute('aria-hidden', 'false')
    await expect.poll(right).toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('plein:sidebar'))).not.toBe('closed')
    await page.screenshot({
      path: test.info().outputPath('right-panel-switch.png'),
      animations: 'disabled',
    })
  })
}
