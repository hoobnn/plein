import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

test(
  '侧栏拖宽：跟手、松手提交、Esc 取消恢复、方向键微调、刷新后宽度保持',
  { tag: '@core' },
  async ({ page }) => {
    await newProject(page)
    const sidebar = page.locator('aside[aria-label="侧栏"]')
    await expect(sidebar).toBeVisible()
    const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
    const width = async () => (await sidebar.boundingBox())!.width
    const before = await width()

    // 拖动中宽度就跟着走（跟手），松手提交偏好
    const box = await handle.boundingBox()
    const y = box!.y + box!.height / 2
    const x = box!.x + box!.width / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 40, y, { steps: 4 })
    expect(await width()).toBeGreaterThan(before + 20)
    await page.mouse.move(x + 80, y, { steps: 4 })
    await page.mouse.up()
    const widened = await width()
    expect(widened).toBeGreaterThan(before + 60)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('plein:sidebar-width')))
      .toBe(String(Math.round(widened)))

    // Esc 取消：宽度恢复拖拽前值，偏好不动
    const stored = await page.evaluate(() => localStorage.getItem('plein:sidebar-width'))
    const box2 = await handle.boundingBox()
    await page.mouse.move(box2!.x + box2!.width / 2, y)
    await page.mouse.down()
    await page.mouse.move(box2!.x + box2!.width / 2 + 60, y, { steps: 4 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await width()).toBe(widened)
    expect(await page.evaluate(() => localStorage.getItem('plein:sidebar-width'))).toBe(stored)

    // 方向键微调：8px 一步并提交
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    expect(await width()).toBe(Math.round(widened) + 8)
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('plein:sidebar-width')))
      .toBe(String(Math.round(widened) + 8))

    // 刷新后宽度保持
    await page.reload()
    await waitEngine(page)
    await expect(sidebar).toBeVisible()
    expect(await width()).toBe(Math.round(widened) + 8)
  },
)
