import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const filter of ['search', 'type'] as const) {
  for (const collapsed of [false, true]) {
    test(`分组 ${filter} 筛选期间停用折叠，退出后保留${collapsed ? '收起' : '展开'}状态`, async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width: 800, height: 560 })
      await newProject(page)
      const group = await page.evaluate(() => {
        const engine = window.__plein
          .engine as unknown as import('../packages/canvas-core/src/engine').Engine
        const ids = ['组内文本甲', '组内文本乙'].map((name, i) =>
          window.__plein.addNode({
            type: 'plein/text',
            name,
            params: {},
            x: 500 + i * 400,
            y: 500,
          }),
        )
        engine.selection.set(ids)
        engine.groupSelection()
        const id = engine.selection.values()[0]!
        engine.selection.clear()
        engine.doc.flush()
        return id
      })
      const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
      const row = sidebar.locator(`[role="treeitem"][data-id="${group}"]`)
      await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
      if (collapsed) await row.getByRole('button', { name: '折叠', exact: true }).click()
      const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
      if (filter === 'search') {
        await sidebar.getByRole('button', { name: '搜索', exact: true }).click()
        await sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true }).fill('组内文本')
      } else {
        await sidebar.getByRole('button', { name: '按类型筛选', exact: true }).click()
        await page.getByRole('menuitemradio', { name: '文本', exact: true }).click()
      }
      await expect(sidebar.getByRole('treeitem')).toHaveCount(3)
      await expect(row).toHaveAttribute('aria-expanded', 'true')
      const caret = row.getByRole('button', { name: '折叠', exact: true })
      // 停用控件必须解释筛选结果为何一直展开，不能悄悄修改退出筛选后的偏好。
      const disabled = await caret.isDisabled()
      const hint = await caret.getAttribute('title')
      await sidebar.screenshot({
        path: test.info().outputPath('filtered-groups-expanded.png'),
        animations: 'disabled',
      })
      const point = await caret.boundingBox()
      await page.mouse.click(point!.x + point!.width / 2, point!.y + point!.height / 2)
      if (filter === 'type') {
        const all = sidebar.getByRole('button', { name: /^(展开|折叠)全部分组$/ })
        await expect(all).toBeDisabled()
        await expect(all).toHaveAttribute('title', '筛选时分组保持展开，清除筛选后可折叠')
        const point = await all.boundingBox()
        await page.mouse.click(point!.x + point!.width / 2, point!.y + point!.height / 2)
        await sidebar.getByRole('button', { name: '按类型筛选', exact: true }).click()
        await page.getByRole('menuitemradio', { name: '全部类型', exact: true }).click()
      } else
        await sidebar.getByRole('textbox', { name: '搜索画布元素', exact: true }).press('Escape')
      await expect(row).toHaveAttribute('aria-expanded', String(!collapsed))
      expect(disabled).toBe(true)
      expect(hint).toBe('筛选时分组保持展开，清除筛选后可折叠')
      await expect(sidebar.getByRole('treeitem')).toHaveCount(collapsed ? 1 : 3)
      const toggle = row.getByRole('button', { name: collapsed ? '展开' : '折叠', exact: true })
      await expect(toggle).toBeEnabled()
      await toggle.click()
      await expect(sidebar.getByRole('treeitem')).toHaveCount(collapsed ? 3 : 1)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([])
      await sidebar.screenshot({
        path: test.info().outputPath('filter-collapse-restored.png'),
        animations: 'disabled',
      })
      expect(errors).toEqual([])
    })
  }
}
