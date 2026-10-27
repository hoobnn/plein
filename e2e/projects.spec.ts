import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

/** 项目和画布的增删改：画布页改过的东西回到首页能看到（列表数据走查询缓存，改完要失效重拉） */
test('项目改名、加画布、首页重命名和删除', { tag: '@core' }, async ({ page }) => {
  const name = `项目 ${Date.now()}`
  await newProject(page)

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
  const title = card.getByRole('link', { name, exact: true })
  // 隐藏操作不占据正文宽度，否则五个按钮会把标题和画布数挤成几个字。
  expect((await title.boundingBox())!.width).toBeGreaterThan(
    (await card.boundingBox())!.width * 0.8,
  )
  await expect(title).toHaveAttribute('title', name)
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await card.hover()
  await card.getByRole('button', { name: '重命名' }).click()
  await page.locator('.home-card input').fill(`${name} 改`)
  await page.keyboard.press('Enter')
  const renamed = page.getByRole('listitem').filter({ hasText: `${name} 改` })
  await expect(renamed).toBeVisible()

  await page.setViewportSize({ width: 800, height: 900 })
  const renamedTitle = renamed.getByRole('link', { name: `${name} 改`, exact: true })
  expect((await renamedTitle.boundingBox())!.width).toBeGreaterThan(
    (await renamed.boundingBox())!.width * 0.8,
  )
  await renamedTitle.focus()
  await expect(renamed.locator('.home-card-actions')).toHaveCSS('opacity', '1')

  await renamed.hover()
  await renamed.getByRole('button', { name: '删除' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await expect(renamed).toHaveCount(0)
})

/** 项目包：首页导出（说明范围、可选历史候选），再导入同一个包，作为副本出现并打开画布 */
test('导出项目包再导入：预检后作为副本导入', { tag: '@core' }, async ({ page }) => {
  const name = `迁移 ${Date.now()}`
  await newProject(page)
  await page.getByTitle('重命名项目').click()
  await page.getByRole('textbox').fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  await page.goto('/')
  const card = page.getByRole('listitem').filter({ hasText: name })
  await card.hover()
  await card.getByRole('button', { name: '导出项目包' }).click()
  const dialog = page.getByRole('dialog', { name: '导出项目包' })
  await expect(dialog).toContainText('平台密钥')
  await expect(dialog).toContainText('1 张画布')
  await dialog.getByRole('switch', { name: '包含历史候选' }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: '导出' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.plein$/)
  const file = await download.path()

  await page.getByTestId('project-import-input').setInputFiles(file)
  const preview = page.getByRole('dialog', { name: `导入「${name}」` })
  await expect(preview).toContainText('会作为副本导入')
  await preview.getByRole('button', { name: '作为副本导入' }).click()
  await waitEngine(page)
  await expect(page.getByRole('button', { name: `${name}（副本）`, exact: true })).toBeVisible()
})
