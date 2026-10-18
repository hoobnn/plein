import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

// 同时在生产构建和开发 StrictMode 下运行，确保一次性打开目标不会被 effect 重放清掉。
test('角色卡编辑档案直达对应角色的时期分页，反复打开保持目标正确', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '新建角色', exact: true }).first().click()
  await panel.getByRole('textbox', { name: '名称', exact: true }).fill('档案导航回归')
  await panel.getByRole('button', { name: '时期与服饰', exact: true }).click()
  await panel.getByRole('button', { name: '添加时期', exact: true }).click()
  await panel.getByRole('button', { name: '青年', exact: true }).click()
  await panel.getByRole('button', { name: '保存并添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  const generator = page.getByTestId('generator')
  await expect(generator.getByRole('textbox', { name: '节点名称' })).toHaveValue('档案导航回归')
  for (let attempt = 0; attempt < 2; attempt++) {
    await generator.getByRole('button', { name: '编辑档案', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
      '档案导航回归',
    )
    await expect(panel.getByRole('button', { name: '时期与服饰 1', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(panel.getByRole('button', { name: '角色资产', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel).toBeHidden()
  }
})

for (const filter of ['搜索', '标签'] as const) {
  test(`${filter} 无匹配时明确说明筛选结果，清空后恢复当前项目条目`, async ({ page }) => {
    await newProject(page)
    const canvas = await (
      await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
    ).json()
    const result = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: '筛选恢复角色',
        projectId: canvas.projectId,
        tags: { gender: '女' },
      },
    })
    expect(result.status()).toBe(201)
    await page.getByRole('button', { name: '资产库', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel
      .getByRole('group', { name: '范围', exact: true })
      .getByRole('button', { name: '本项目', exact: true })
      .click()
    await expect(panel.getByRole('listitem')).toHaveCount(1)
    if (filter === '标签') await page.setViewportSize({ width: 320, height: 700 })
    const search = panel.getByRole('searchbox', { name: '搜索角色', exact: true })
    if (filter === '搜索') await search.fill('不存在的角色')
    else {
      await panel.getByRole('combobox', { name: '性别', exact: true }).click()
      await page.getByRole('option', { name: '男', exact: true }).click()
    }
    await expect(panel.getByRole('listitem')).toHaveCount(0)
    await expect(panel.getByText('没有符合条件的角色', { exact: true })).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await panel.screenshot({
      path: test.info().outputPath('library-filter-empty.png'),
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: '清空搜索和筛选', exact: true }).click()
    await expect(panel.getByRole('listitem')).toHaveCount(1)
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
    await expect(panel.getByRole('combobox', { name: '性别', exact: true })).toHaveText('性别')
    await expect(
      panel
        .getByRole('group', { name: '范围', exact: true })
        .getByRole('button', { name: '本项目', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
  })
}

test('有结果时可同时重置关键词和标签，保留收藏范围并聚焦搜索', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  for (const gender of ['女', '男']) {
    const response = await page.request.post('/api/library', {
      data: {
        kind: 'character',
        name: `筛选组合 ${gender}`,
        projectId: canvas.projectId,
        tags: { gender },
      },
    })
    expect(response.status()).toBe(201)
    if (gender === '女') {
      const item = await response.json()
      expect(
        (await page.request.patch(`/api/library/${item.id}`, { data: { favorite: true } })).ok(),
      ).toBe(true)
    }
  }
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  const favorite = panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: '收藏', exact: true })
  await favorite.click()
  await expect(panel.getByRole('listitem').filter({ hasText: '筛选组合 女' })).toHaveCount(1)
  const favorites = await panel.getByRole('listitem').count()
  const search = panel.getByRole('searchbox', { name: '搜索角色', exact: true })
  await search.fill('筛选组合')
  const gender = panel.getByRole('combobox', { name: '性别', exact: true })
  await gender.click()
  await page.getByRole('option', { name: '女', exact: true }).click()
  await expect(panel.getByRole('listitem')).toHaveCount(1)
  await panel.getByRole('button', { name: '重置筛选', exact: true }).click()
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(gender).toHaveText('性别')
  await expect(favorite).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('listitem')).toHaveCount(favorites)
  await expect(panel.getByRole('button', { name: '重置筛选', exact: true })).toHaveCount(0)
})

test('真正空库和空白关键词保留新建入口，清空无匹配查询后恢复空库提示', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  const empty = panel.getByText('这个项目还没有角色', { exact: true })
  await expect(empty).toBeVisible()
  const search = panel.getByRole('searchbox', { name: '搜索角色', exact: true })
  await search.fill('   ')
  await expect(empty).toBeVisible()
  await expect(panel.getByRole('button', { name: '重置筛选', exact: true })).toHaveCount(0)
  await search.fill('无匹配')
  await expect(empty).toHaveCount(0)
  await panel.getByRole('button', { name: '清空搜索和筛选', exact: true }).click()
  await expect(empty).toBeVisible()
  await expect(
    panel.locator('.ui-empty').getByRole('button', { name: '新建角色', exact: true }),
  ).toBeVisible()
})
