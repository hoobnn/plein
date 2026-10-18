import { expect, type Page, test } from '@playwright/test'
import { centerOf, contextMenu, newProject, settle } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => [
    window.__plein.addNode({
      type: 'plein/text',
      name: '海边文本',
      params: { text: '海边' },
      x: 1600,
      y: 1000,
    }),
    window.__plein.addNode({
      type: 'plein/text',
      name: '山林文本',
      params: { text: '山林' },
      x: 2100,
      y: 1000,
    }),
    window.__plein.addNode({ type: 'plein/image', name: '海边图片', params: {}, x: 2600, y: 1000 }),
  ])
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
  return { sidebar, ids }
}

for (const close of ['Escape', 'button']) {
  test(`侧栏搜索通过 ${close} 关闭后焦点返回搜索入口，结果恢复`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 })
    const { sidebar } = await fixture(page)
    const open = sidebar.getByRole('button', { name: '搜索', exact: true })
    await open.click()
    const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
    await expect(query).toBeFocused()
    await query.fill('海边')
    await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
    if (close === 'Escape')
      await sidebar.screenshot({
        path: test.info().outputPath('sidebar-search.png'),
        animations: 'disabled',
      })
    if (close === 'Escape') await query.press('Escape')
    else await sidebar.getByRole('button', { name: '关闭搜索', exact: true }).click()
    await expect(query).toHaveCount(0)
    await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
    await expect(open).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(query).toBeFocused()
    await expect(query).toHaveValue('')
  })
}

for (const mode of ['composition', 'legacy229']) {
  test(`侧栏搜索的 ${mode} 确认取消不关闭搜索或丢失查询`, async ({ page }) => {
    const { sidebar } = await fixture(page)
    await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
    const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
    await query.fill('海边')
    const selection = await page.evaluate(() => window.__plein.engine.selection.values())
    const sent = await query.evaluate((input, mode) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: mode === 'composition',
        keyCode: mode === 'legacy229' ? 229 : 27,
      })
      input.dispatchEvent(event)
      return { composing: event.isComposing, keyCode: event.keyCode }
    }, mode)
    if (mode === 'composition') expect(sent.composing).toBe(true)
    else expect(sent.keyCode).toBe(229)
    await expect(query).toBeVisible()
    await expect(query).toHaveValue('海边')
    await expect(query).toBeFocused()
    await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual(selection)
  })
}

test('侧栏类型与名称组合筛选实时响应重命名和删除，并能定位正确节点', async ({ page }) => {
  const { sidebar, ids } = await fixture(page)
  await sidebar.getByRole('button', { name: '按类型筛选', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '文本', exact: true }).click()
  await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
  await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
  const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
  await query.fill('海边')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(1)
  const original = sidebar.locator(`[role="treeitem"][data-id="${ids[0]}"]`)
  await expect(original).toHaveAccessibleName('海边文本 定位到画布')
  await original.press('F2')
  const rename = original.getByRole('textbox')
  await rename.fill('海湾文本')
  await rename.press('Enter')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(0)
  await expect(sidebar.getByText('没有符合条件的元素', { exact: true })).toBeVisible()
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids[0]!)).toBe(
    '海湾文本',
  )
  await query.fill('海湾')
  const result = sidebar.getByRole('treeitem', { name: '海湾文本 定位到画布', exact: true })
  await result.click()
  await expect(result).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([ids[0]])
  await result.getByRole('button', { name: '定位到画布', exact: true }).click()
  await settle(page, ids[0]!)
  const position = await centerOf(page, ids[0]!)
  const bounds = (await sidebar.boundingBox())!
  expect(position.x).toBeGreaterThan(bounds.x + bounds.width)
  await contextMenu(page, ids[0]!, '删除')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(0)
  expect(await page.evaluate((id) => !!window.__plein.engine.doc.get(id), ids[0]!)).toBe(false)
})
