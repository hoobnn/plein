import { expect, test, type Locator } from './fixtures'
import { addNode, newProject } from './canvas'

const noCssAnimation = async (locator: Locator) => {
  await expect(locator).toBeVisible()
  expect(await locator.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
}

test('Motion 浮层不叠加旧 CSS 进场动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await newProject(page)
  await addNode(page, '生成视频')

  await page.getByRole('button', { name: '生成模式', exact: true }).click()
  await noCssAnimation(page.getByRole('dialog', { name: '视频生成模式', exact: true }))
  await page.getByRole('button', { name: '生成模式', exact: true }).click()

  await page.getByRole('button', { name: '放大编辑提示词', exact: true }).click()
  await noCssAnimation(page.getByRole('dialog', { name: '编辑提示词', exact: true }))
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  await noCssAnimation(page.getByRole('dialog', { name: '添加节点', exact: true }))
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  await noCssAnimation(page.getByRole('status').filter({ hasText: '画布已经很整齐了' }))
})
