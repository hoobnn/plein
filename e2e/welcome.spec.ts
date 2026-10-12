import { expect, test } from '@playwright/test'
import { byName, waitEngine } from './canvas'

const MOCK = '/api/providers/plein/mock/config'

test('首次启动引导：没有可用平台时弹出，跳过后从短剧模板开始', async ({ page }) => {
  // 停用 mock 平台，模拟刚装好、还没填任何密钥
  const off = await page.request.put(MOCK, { data: { enabled: false } })
  expect(off.ok()).toBe(true)
  try {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: '欢迎使用 Plein' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: '下一步' })).toBeDisabled()
    await dialog.getByRole('button', { name: '跳过' }).click()
    await expect(dialog).toContainText('还没有可用的模型平台')
    await dialog.getByRole('button', { name: /从短剧模板开始/ }).click()

    await expect(page).toHaveURL(/#\/c\//)
    await waitEngine(page)
    await expect(page.locator('.ui-toast')).toContainText('短剧模板已铺出')
    expect((await byName(page, '分镜（双击展开镜头）')).kind).toBe('node')

    // 看过一次就不再弹
    await page.goto('/')
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    await expect(dialog).toHaveCount(0)
  } finally {
    await page.request.put(MOCK, { data: { enabled: true } })
  }
})
