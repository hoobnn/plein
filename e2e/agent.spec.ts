import { expect, test } from '@playwright/test'
import { elements, newProject } from './canvas'

/** 内置智能体：不装 CLI，用 mock 的工具调用模型跑完一轮，再整轮撤销 */
test('内置小满建节点并运行，整轮撤销', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手' }).click()
  const panel = page.getByRole('complementary', { name: '助手' })
  await expect(panel.getByText('Mock 智能体').first()).toBeVisible()

  await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送' }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const images = async () =>
    (await elements(page)).filter((e) => e.nodeType === 'plein/image').length
  await expect.poll(images).toBe(1)

  await panel.getByRole('button', { name: '撤销这一轮' }).click()
  await expect.poll(images).toBe(0)
})

/** 计划模式：先出计划卡片，同意后小满按步骤执行，逐步打勾 */
test('先出计划，同意后执行并打勾', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手' }).click()
  const panel = page.getByRole('complementary', { name: '助手' })
  const toggle = panel.getByRole('button', { name: '先出计划' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送' }).click()
  await expect(panel.getByText('小满想这样做：新建一个生成图片节点并出图')).toBeVisible()
  const images = async () =>
    (await elements(page)).filter((e) => e.nodeType === 'plein/image').length
  // 同意之前不动画布
  expect(await images()).toBe(0)

  await panel.getByRole('button', { name: '同意并执行' }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  await expect(panel.locator('.plein-plan-step[data-status="done"]')).toHaveCount(2)
  await expect(panel.getByText('2/2')).toBeVisible()
  await expect.poll(images).toBe(1)
})
