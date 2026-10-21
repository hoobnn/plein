import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const ids = await page.evaluate(() => {
    const text = ['已完成文本', '待生成文本'].map((name, i) =>
      window.__plein.addNode({ type: 'plein/llm', name, params: {}, x: 300, y: i * 400 }),
    )
    const image = window.__plein.addNode({
      type: 'plein/image',
      name: '待生成图片',
      params: {},
      x: 1000,
      y: 0,
    })
    const node = window.__plein.engine.doc.mutable(text[0]!) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('results', [
      {
        id: 'filter-result',
        port: 'text',
        runId: 'filter-fixture',
        at: 1,
        value: { type: 'text', text: '已确认的文字' },
      },
    ])
    node.set('adopted', 'filter-result')
    return { text, image }
  })
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const text = page.getByRole('region', { name: '文本', exact: true })
  const image = page.getByRole('region', { name: '图片', exact: true })
  await text.getByRole('button', { name: '筛选', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '已生成', exact: true }).click()
  // 菜单有退场动画，等它卸载，否则两栏菜单里的同名选项会同时存在
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(text.locator('.board-text')).toHaveCount(1)
  await image.getByRole('button', { name: '筛选', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '待生成', exact: true }).click()
  return { ids, text, image }
}

test('展开其他分栏再还原，保留每栏独立筛选与显示结果', async ({ page }) => {
  const f = await fixture(page)
  await f.image.getByRole('button', { name: '展开此栏', exact: true }).click()
  await expect(f.text).toHaveCount(0)
  await f.image.getByRole('button', { name: '还原分栏', exact: true }).click()
  await expect(f.text.getByRole('button', { name: '筛选', exact: true })).toHaveText('已生成')
  await expect(f.text.locator('.board-text')).toHaveCount(1)
  await expect(f.image.getByRole('button', { name: '筛选', exact: true })).toHaveText('待生成')
  await f.text.getByRole('button', { name: '展开此栏', exact: true }).click()
  await f.text.getByRole('button', { name: '还原分栏', exact: true }).click()
  await expect(f.image.getByRole('button', { name: '筛选', exact: true })).toHaveText('待生成')
})

for (const all of [false, true]) {
  test(`删除${all ? '全部画布' : '筛选栏'}内容再撤销，恢复各栏原筛选`, async ({ page }) => {
    const f = await fixture(page)
    if (all) await f.image.getByRole('button', { name: '展开此栏', exact: true }).click()
    await page.evaluate(
      (ids) => {
        const engine = window.__plein.engine as typeof window.__plein.engine & {
          deleteSelection(): void
        }
        engine.selection.set(ids)
        engine.deleteSelection()
      },
      all ? [...f.ids.text, f.ids.image] : f.ids.text,
    )
    await expect(f.text).toHaveCount(0)
    if (all) await expect(page.getByText('画布上还没有内容', { exact: true })).toBeVisible()
    await page.evaluate(() =>
      (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
    )
    await expect(f.text.getByRole('button', { name: '筛选', exact: true })).toHaveText('已生成')
    await expect(f.text.locator('.board-text')).toHaveCount(1)
    await expect(f.image.getByRole('button', { name: '筛选', exact: true })).toHaveText('待生成')
  })
}

test('没有匹配结果的筛选栏临时隐藏后仍为空，采用结果恢复后自动显示', async ({ page }) => {
  const f = await fixture(page)
  const adopt = (value: string | null) =>
    page.evaluate(
      ({ id, value }) => {
        const node = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        node.set('adopted', value)
      },
      { id: f.ids.text[0]!, value },
    )
  await adopt(null)
  await expect(f.text.getByText('没有符合筛选的内容', { exact: true })).toBeVisible()
  await f.image.getByRole('button', { name: '展开此栏', exact: true }).click()
  await f.image.getByRole('button', { name: '还原分栏', exact: true }).click()
  await expect(f.text.getByRole('button', { name: '筛选', exact: true })).toHaveText('已生成')
  await expect(f.text.getByText('没有符合筛选的内容', { exact: true })).toBeVisible()
  await f.image.getByRole('button', { name: '展开此栏', exact: true }).click()
  await adopt('filter-result')
  await f.image.getByRole('button', { name: '还原分栏', exact: true }).click()
  await expect(f.text.locator('.board-text')).toHaveCount(1)
  await expect(f.text.getByText('没有符合筛选的内容', { exact: true })).toHaveCount(0)
})

test('定位后返回故事板保留筛选，切换到另一画布使用默认筛选', async ({ page }) => {
  const f = await fixture(page)
  await f.text.locator('.board-text').first().click()
  await expect(f.text).toHaveCount(0)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(f.text.getByRole('button', { name: '筛选', exact: true })).toHaveText('已生成')
  await expect(f.text.locator('.board-text')).toHaveCount(1)
  await expect(f.image.getByRole('button', { name: '筛选', exact: true })).toHaveText('待生成')
  await page.screenshot({
    path: test.info().outputPath('board-filters-retained.png'),
    animations: 'disabled',
  })
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const other = await (
    await page.request.post('/api/canvases', {
      data: { projectId: canvas.projectId, title: '独立筛选画布' },
    })
  ).json()
  await page.evaluate((id) => {
    location.hash = `#/c/${id}`
  }, other.id)
  await expect
    .poll(() =>
      page.evaluate((id) => !!window.__plein && !window.__plein.engine.doc.get(id), f.ids.text[0]!),
    )
    .toBe(true)
  await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '新画布待生成文本',
      params: {},
      x: 300,
      y: 300,
    }),
  )
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await expect(f.text.getByRole('button', { name: '筛选', exact: true })).toHaveText('全部')
  await expect(f.text.locator('.board-text')).toHaveCount(1)
  await expect(f.text).toContainText('新画布待生成文本')
})
