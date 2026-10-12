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
