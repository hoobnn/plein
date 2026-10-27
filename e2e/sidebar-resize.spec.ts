import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

const handleOf = (page: Page) => page.getByRole('separator', { name: '调整侧栏宽度', exact: true })
const savedWidth = (page: Page) => page.evaluate(() => localStorage.getItem('plein:sidebar-width'))

async function startDrag(page: Page) {
  const handle = handleOf(page)
  // 等待侧栏滑入动画结束，再读取实际拖动热区。
  await handle.hover()
  const bounds = (await handle.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 80, y, { steps: 4 })
  await expect(handle).toHaveAttribute('aria-valuenow', '352')
  await expect(handle).toHaveAttribute('data-dragging', 'true')
  return { handle, x, y }
}

test('拖动宽度限制、持久化、键盘微调与双击恢复默认', async ({ page }) => {
  await newProject(page)
  const { handle, y } = await startDrag(page)
  expect(await savedWidth(page)).toBeNull()
  await page.mouse.move(1000, y)
  await expect(handle).toHaveAttribute('aria-valuenow', '480')
  await page.mouse.up()
  expect(await savedWidth(page)).toBe('480')
  await expect(handle).not.toHaveAttribute('data-dragging')
  await expect(page.locator('html')).not.toHaveClass(/plein-resizing/)
  await handle.focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '440')
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '432')
  await handle.dblclick()
  await expect(handle).toHaveAttribute('aria-valuenow', '272')
  const next = await startDrag(page)
  await page.mouse.move(20, next.y)
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '220')
  expect(await savedWidth(page)).toBe('220')
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await expect(sidebar).toHaveCSS('width', '220px')
  await sidebar.screenshot({
    path: test.info().outputPath('sidebar-min-width.png'),
    animations: 'disabled',
  })
  await page.reload()
  await expect(handleOf(page)).toHaveAttribute('aria-valuenow', '220')
})

for (const interruption of ['close', 'leave'] as const) {
  test(`拖动遇到 ${interruption} 后恢复原宽度并清理拖动状态，可重新拖动`, async ({ page }) => {
    await newProject(page)
    const { x, y } = await startDrag(page)
    const url = page.url()
    if (interruption === 'close') await page.keyboard.press('ControlOrMeta+Backslash')
    else await page.evaluate(() => (location.hash = '#/'))
    await expect(page.locator('html')).not.toHaveClass(/plein-resizing/)
    await page.mouse.move(x + 130, y)
    await page.mouse.up()
    if (interruption === 'close')
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    if (interruption === 'leave') {
      await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
      await page.evaluate((url) => (location.hash = new URL(url).hash), url)
    }
    await expect(handleOf(page)).toHaveAttribute('aria-valuenow', '272')
    await expect(handleOf(page)).not.toHaveAttribute('data-dragging')
    // 未完成的调整不得写入偏好。
    expect(await savedWidth(page)).toBeNull()
    const again = await startDrag(page)
    await page.mouse.up()
    await expect(again.handle).toHaveAttribute('aria-valuenow', '352')
    expect(await savedWidth(page)).toBe('352')
  })
}
