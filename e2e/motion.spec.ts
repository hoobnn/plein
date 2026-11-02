import { expect, test, type Locator } from './fixtures'
import { addNode, newProject } from './canvas'

const noCssAnimation = async (locator: Locator) => {
  await expect(locator).toBeVisible()
  expect(await locator.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
}

test('Popover 碰撞翻转后按实际 side 进退场', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await newProject(page)
  await addNode(page, '生成视频')
  const trigger = page.getByRole('button', { name: '生成模式', exact: true })
  await trigger.evaluate((element) => {
    element.style.position = 'fixed'
    element.style.top = '0'
    element.style.left = '400px'
    element.style.zIndex = '100'
  })
  await trigger.click()
  const popover = page.getByRole('dialog', { name: '视频生成模式', exact: true })
  await expect(popover).toHaveAttribute('data-side', 'bottom')
  await page.waitForTimeout(200)
  await expect(popover).toHaveCSS('opacity', '1')
  await trigger.click()
  await expect(popover).toHaveAttribute('data-plein-exiting', '')
  const keyframes = await popover.evaluate((element) =>
    element.getAnimations().flatMap((animation) => {
      const effect = animation.effect
      return effect instanceof KeyframeEffect ? effect.getKeyframes() : []
    }),
  )
  expect(JSON.stringify(keyframes)).toContain('translateY(-2px)')
})

test('弹层结束进场与再次打开后保持可见', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await newProject(page)
  await addNode(page, '生成视频')

  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: '切换画布', exact: true }).click()
    const switcher = page.getByRole('dialog', { name: '画布', exact: true })
    await page.waitForTimeout(1000)
    await expect(switcher).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await expect(switcher).toHaveCount(0)
  }

  await page.getByRole('button', { name: '添加节点', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '添加节点', exact: true })
  await page.waitForTimeout(1000)
  await expect(menu).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '模型', exact: true }).click()
  const dropdown = page.getByRole('dialog', { name: '选择模型', exact: true })
  await page.waitForTimeout(1000)
  await expect(dropdown).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
})

test('冷启动不被 Motion 阻塞，延后浮层与首页提示正常进场', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.route('**/*motion*', (route) => route.abort())
  await page.goto('/')
  await expect(page.locator('.home-bar')).toBeVisible()
  await expect(page.getByRole('button', { name: '新建项目', exact: true }).first()).toBeVisible()
  await page.unroute('**/*motion*')

  await newProject(page)
  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  await page.getByRole('button', { name: '整理画布', exact: true }).click()
  await page.locator('.app-brand').click()
  await expect(page.getByRole('status').filter({ hasText: '画布已经很整齐了' })).toBeVisible()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  expect(await settings.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')

  const card = page.getByRole('listitem').filter({ hasText: '未命名项目' }).first()
  await card.hover()
  await card.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: /删除项目/ })
  await expect(confirmation).toBeVisible()
  expect(await confirmation.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(
    0,
  )
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
})

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
