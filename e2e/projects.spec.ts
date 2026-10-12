import { expect, test } from '@playwright/test'
import { waitEngine } from './canvas'

/** 项目和画布的增删改：画布页改过的东西回到首页能看到（列表数据走查询缓存，改完要失效重拉） */
test('项目改名、加画布、首页重命名和删除', async ({ page }) => {
  const name = `项目 ${Date.now()}`
  await page.goto('/')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await waitEngine(page)

  // 页头改项目名
  await page.getByTitle('重命名项目').click()
  await page.getByRole('textbox').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  // 新建第二张画布，下拉里两张都在
  await page.getByRole('button', { name: '切换画布' }).click()
  await page.getByRole('button', { name: '新建画布' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('第二张')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '切换画布' })).toHaveText('第二张')
  await waitEngine(page)
  await page.getByRole('button', { name: '切换画布' }).click()
  const menu = page.getByRole('dialog', { name: '画布' })
  await expect(menu.getByRole('button')).toHaveCount(5) // 两张画布 + 新建、重命名、删除
  await page.keyboard.press('Escape')

  // 回首页：改过的名字和画布数都是新的
  await page.goto('/')
  const card = page.getByRole('listitem').filter({ hasText: name })
  await expect(card).toContainText('2 张画布')

  await card.hover()
  await card.getByRole('button', { name: '重命名' }).click()
  await page.locator('.home-card input').fill(`${name} 改`)
  await page.keyboard.press('Enter')
  const renamed = page.getByRole('listitem').filter({ hasText: `${name} 改` })
  await expect(renamed).toBeVisible()

  await renamed.hover()
  await renamed.getByRole('button', { name: '删除' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await expect(renamed).toHaveCount(0)
})
