import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const { engine, addNode } = window.__plein
    const first = addNode({
      type: 'plein/text',
      name: '组内一',
      params: { text: '一' },
      x: 1000,
      y: 500,
    })
    const second = addNode({
      type: 'plein/text',
      name: '组内二',
      params: { text: '二' },
      x: 1400,
      y: 500,
    })
    engine.selection.set([first, second])
    ;(engine as typeof engine & { groupSelection(): void }).groupSelection()
    const frame = [...engine.doc.elements()].find((element) => element.kind === 'frame')!.id
    const outside = addNode({
      type: 'plein/text',
      name: '组外',
      params: { text: '外' },
      x: 2000,
      y: 500,
    })
    engine.selection.set([])
    return { first, second, frame, outside }
  })
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await expect(sidebar.getByRole('treeitem')).toHaveCount(4)
  return { sidebar, ids }
}
function snapshot(page: Page) {
  return page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .map((element) => ({
        id: element.id,
        name: element.name,
        parent: element.parentId,
        rect: window.__plein.engine.doc.worldRect(element.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  )
}

test('侧栏上下和首尾键只移动可见行焦点，Enter 与空格才激活选区', async ({ page }) => {
  const { sidebar } = await fixture(page)
  const before = await snapshot(page)
  const rows = sidebar.getByRole('treeitem')
  await rows.nth(0).focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  expect(
    await rows.evaluateAll(
      (elements) => elements.filter((element) => element.tabIndex === 0).length,
    ),
  ).toBe(1)
  await page.keyboard.press('End')
  await expect(rows.nth(3)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(3)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(rows.nth(0)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(rows.nth(0)).toBeFocused()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
  expect(await snapshot(page)).toEqual(before)
  const first = await rows.nth(0).getAttribute('data-id')
  await page.keyboard.press('Space')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([first])
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([first])
  const second = await rows.nth(1).getAttribute('data-id')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([second])
  expect(await snapshot(page)).toEqual(before)
  await page.keyboard.press('Tab')
  await expect(sidebar.getByRole('separator', { name: '调整侧栏宽度', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(rows.nth(1)).toBeFocused()
})

test('分组左右键展开折叠并进入子项或返回父项，不访问隐藏行', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const { sidebar, ids } = await fixture(page)
  const before = await snapshot(page)
  const group = sidebar.locator(`[role="treeitem"][data-id="${ids.frame}"]`)
  await group.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
  await page.keyboard.press('ArrowRight')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(group).toBeFocused()
  await page.keyboard.press('ArrowRight')
  const child = sidebar.getByRole('treeitem').nth(2)
  await expect(child).toBeFocused()
  await sidebar.screenshot({
    path: test.info().outputPath('sidebar-tree-focus.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('ArrowLeft')
  await expect(group).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowUp')
  await expect(sidebar.locator(`[role="treeitem"][data-id="${ids.outside}"]`)).toBeFocused()
  expect(await snapshot(page)).toEqual(before)
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
})

test('筛选中的分组导航只访问匹配行，退出筛选保留原折叠状态', async ({ page }) => {
  const { sidebar, ids } = await fixture(page)
  const group = sidebar.locator(`[role="treeitem"][data-id="${ids.frame}"]`)
  await group.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
  const query = sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true })
  await query.fill('组内一')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
  await group.focus()
  await page.keyboard.press('ArrowRight')
  await expect(sidebar.locator(`[role="treeitem"][data-id="${ids.first}"]`)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(group).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
  await query.focus()
  await page.keyboard.press('Escape')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.getByRole('treeitem')).toHaveCount(2)
})

for (const mode of ['composition', 'legacy229']) {
  test(`树行的 ${mode} Enter 不激活画布选区`, async ({ page }) => {
    const { sidebar } = await fixture(page)
    const row = sidebar.getByRole('treeitem').first()
    await row.focus()
    const before = await snapshot(page)
    await row.evaluate(
      (element, mode) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
            isComposing: mode === 'composition',
            keyCode: mode === 'legacy229' ? 229 : 13,
          }),
        ),
      mode,
    )
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
    expect(await snapshot(page)).toEqual(before)
  })
}

for (const finish of ['Enter', 'Escape']) {
  test(`侧栏键盘改名通过 ${finish} 退出后回到原行，方向键继续浏览而不移动节点`, async ({
    page,
  }) => {
    const { sidebar, ids } = await fixture(page)
    const row = sidebar.locator(`[role="treeitem"][data-id="${ids.first}"]`)
    await row.focus()
    await page.keyboard.press('F2')
    const input = row.getByRole('textbox', { name: '元素名称', exact: true })
    await input.fill('键盘改名完成')
    await input.press(finish)
    await expect(input).toHaveCount(0)
    await expect(row).toBeFocused()
    const before = await snapshot(page)
    const index = await row.evaluate((el) =>
      [...el.parentElement!.querySelectorAll('[role="treeitem"]')].indexOf(el),
    )
    await page.keyboard.press('ArrowUp')
    await expect(sidebar.getByRole('treeitem').nth(Math.max(0, index - 1))).toBeFocused()
    expect(await snapshot(page)).toEqual(before)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids.first)).toBe(
      finish === 'Enter' ? '键盘改名完成' : '组内一',
    )
  })
}

for (const mode of ['composition', 'legacy229'] as const) {
  for (const key of ['Enter', 'Escape']) {
    test(`侧栏就地改名 ${mode} 的 ${key} 保留草稿和编辑焦点`, async ({ page }) => {
      const { sidebar, ids } = await fixture(page)
      const row = sidebar.locator(`[role="treeitem"][data-id="${ids.first}"]`)
      await row.press('F2')
      const input = row.getByRole('textbox', { name: '元素名称', exact: true })
      await input.fill('尚未确认的中文名称')
      await input.evaluate(
        (el, { mode, key }) =>
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              code: key,
              bubbles: true,
              cancelable: true,
              isComposing: mode === 'composition',
              keyCode: mode === 'legacy229' ? 229 : key === 'Enter' ? 13 : 27,
            }),
          ),
        { mode, key },
      )
      await expect(input).toBeFocused()
      await expect(input).toHaveValue('尚未确认的中文名称')
      expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, ids.first)).toBe(
        '组内一',
      )
      await input.press('Enter')
      await expect(row).toBeFocused()
      await expect(row).toContainText('尚未确认的中文名称')
      await page.getByRole('button', { name: '撤销', exact: true }).click()
      await expect(row).toContainText('组内一')
    })
  }
}
