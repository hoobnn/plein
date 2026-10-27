import { expect, type Page, test } from './fixtures'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '海边文本',
      params: { text: '海边' },
      x: 1200,
      y: 700,
    })
    window.__plein.addNode({ type: 'plein/image', name: '海边图片', params: {}, x: 1700, y: 700 })
    window.__plein.addNode({
      type: 'plein/text',
      name: '山林文本',
      params: { text: '山林' },
      x: 2200,
      y: 700,
    })
    return id
  })
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
  return { sidebar, id }
}

for (const text of ['海边', '图片']) {
  test(`组合搜索 ${text} 显示当前类型，可直接清除类型并保留查询与焦点`, async ({ page }) => {
    const { sidebar } = await fixture(page)
    await sidebar.getByRole('button', { name: '按类型筛选', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '文本', exact: true }).click()
    await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
    const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
    await query.fill(text)
    await expect(sidebar.getByRole('treeitem')).toHaveCount(text === '海边' ? 1 : 0)
    if (text === '图片')
      await expect(sidebar.getByText('没有符合条件的元素', { exact: true })).toBeVisible()
    const clear = sidebar.getByRole('button', { name: '清除类型筛选：文本', exact: true })
    await expect(clear).toBeVisible()
    await expect(query).toHaveAccessibleDescription('类型：文本')
    await expect(clear).toBeInViewport()
    if (text === '海边')
      await sidebar.screenshot({
        path: test.info().outputPath('sidebar-active-filter.png'),
        animations: 'disabled',
      })
    await clear.focus()
    await page.keyboard.press('Enter')
    await expect(clear).toHaveCount(0)
    await expect(query).toBeFocused()
    await expect(query).toHaveValue(text)
    await expect(query).toHaveAccessibleDescription('')
    await expect(sidebar.getByRole('treeitem')).toHaveCount(text === '海边' ? 2 : 1)
    await expect(sidebar.getByText('没有符合条件的元素', { exact: true })).toHaveCount(0)
    await query.press('Escape')
    await expect(sidebar.getByRole('button', { name: '按类型筛选', exact: true })).toContainText(
      '全部类型',
    )
    await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
  })
}

test('键盘重命名导致搜索结果撤下后，焦点返回查询框继续搜索', async ({ page }) => {
  const { sidebar, id } = await fixture(page)
  await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
  const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
  await query.fill('海边')
  const row = sidebar.locator(`[role="treeitem"][data-id="${id}"]`)
  await row.press('F2')
  await row.getByRole('textbox').fill('山林新名称')
  await row.getByRole('textbox').press('Enter')
  await expect(row).toHaveCount(0)
  await expect(sidebar.getByRole('treeitem')).toHaveCount(1)
  await expect(query).toBeFocused()
  await expect(query).toHaveValue('海边')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('山林新名称')
  await expect(
    sidebar.getByRole('treeitem', { name: '山林新名称 定位到画布', exact: true }),
  ).toBeVisible()
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)).toBe(
    '山林新名称',
  )
})

test('鼠标选中其他结果提交重命名，不把焦点抢回查询框', async ({ page }) => {
  const { sidebar, id } = await fixture(page)
  await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
  const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
  await query.fill('海边')
  const row = sidebar.locator(`[role="treeitem"][data-id="${id}"]`)
  await row.press('F2')
  await row.getByRole('textbox').fill('山林新名称')
  const other = sidebar.getByRole('treeitem', { name: '海边图片 定位到画布', exact: true })
  const otherId = await other.getAttribute('data-id')
  await other.click()
  await expect(row).toHaveCount(0)
  await expect(other).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([otherId])
  await expect(query).not.toBeFocused()
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)).toBe(
    '山林新名称',
  )
})
