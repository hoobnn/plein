import { test, expect } from './fixtures'
import { elements, newProject } from './canvas'

test('二级新建菜单支持悬停、键盘和视口边缘避让 @core', async ({ page }, testInfo) => {
  await newProject(page)
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 640, height: 360 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await page
      .locator('canvas')
      .first()
      .click({
        position: { x: viewport.width - 24, y: Math.round(viewport.height * 0.65) },
        button: 'right',
      })
    const trigger = page.getByRole('menuitem', { name: '新建节点', exact: true })
    await trigger.hover()
    const submenu = page.getByRole('group', { name: '新建节点选项' })
    await expect(submenu).toBeVisible()
    await expect
      .poll(async () => {
        const bounds = (await submenu.boundingBox())!
        return (
          bounds.x >= 7 &&
          bounds.y >= 7 &&
          bounds.x + bounds.width <= viewport.width - 7 &&
          bounds.y + bounds.height <= viewport.height - 7
        )
      })
      .toBe(true)
    const search = submenu.getByRole('textbox', { name: '搜索节点' })
    if (viewport.width < 500) await search.click()
    else await trigger.click()
    await expect(search).toBeFocused()
    await search.fill('Frame')
    await expect(submenu.getByRole('option', { name: '分组框' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(submenu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(trigger).toHaveCount(0)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.mouse.click(500, 250, { button: 'right' })
  await page.getByRole('menuitem', { name: '新建节点', exact: true }).hover()
  const picker = page.getByRole('dialog', { name: '添加节点', exact: true })
  await expect(picker.getByText('主体设定', { exact: true })).toBeAttached()
  await expect(picker.getByRole('option', { name: '文本生成', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('node-menu-dark.png') })
  await picker.getByRole('option', { name: '文本', exact: true }).click()
  await expect
    .poll(async () => (await elements(page)).map((element) => element.nodeType))
    .toEqual(['plein/text'])
})
