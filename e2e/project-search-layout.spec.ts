import { expect, test } from './fixtures'
import { randomUUID } from 'node:crypto'
import { newProject } from './canvas'

test.afterEach(async ({ page }) => {
  // 删除后的列表刷新可能晚于可见断言结束；先等路由处理完，再释放响应所属的 context。
  await page.unrouteAll({ behavior: 'wait' })
})

test('筛选后删除匹配项目，列表剩一项仍可清除搜索并恢复项目', async ({ page }) => {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('#/c/')[1]}`)
  ).json()
  const p = await (
    await page.request.post('/api/projects', { data: { title: '搜索后删除的项目' } })
  ).json()
  await page.request.patch(`/api/projects/${canvas.projectId}`, { data: { title: '保留的项目' } })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const items = await response.json()
    await route.fulfill({
      response,
      json: items.filter((item: { id: string }) => [canvas.projectId, p.id].includes(item.id)),
    })
  })
  await page.goto('/')
  const search = page.getByRole('searchbox', { name: '搜索项目', exact: true })
  await search.fill('搜索后删除')
  const card = page.locator(`[data-project="${p.id}"]`)
  await card.getByRole('button', { name: '删除', exact: true }).click()
  await page
    .getByRole('dialog', { name: /^删除项目/ })
    .getByRole('button', { name: '删除', exact: true })
    .click()
  await expect(card).toHaveCount(0)
  await expect(search).toBeVisible()
  await search.fill('')
  await expect(page.getByRole('link', { name: '保留的项目', exact: true })).toBeVisible()
})

for (const width of [320]) {
  test(`${width}px 项目搜索及导入新建入口完整可点击，不横向溢出`, async ({ page }) => {
    await newProject(page)
    const searchTerm = `Layout project ${width} ${randomUUID()}`
    const title = `${searchTerm} ${'W'.repeat(200 - searchTerm.length - 1)}`
    const created = await page.request.post('/api/projects', { data: { title } })
    expect(created.status()).toBe(201)
    const count = (await (await page.request.get('/api/projects')).json()).length
    await page.goto('/')
    await page.setViewportSize({ width, height: 800 })
    const controls = [
      page.getByRole('searchbox', { name: '搜索项目', exact: true }),
      page.getByRole('button', { name: '导入项目包', exact: true }),
      page.getByRole('button', { name: '新建项目', exact: true }),
    ]
    for (const control of controls) {
      await expect(control).toBeVisible()
      expect(
        await control.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return (
            r.x >= 0 &&
            r.right <= innerWidth &&
            el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          )
        }),
      ).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await controls[0]!.fill(` ${searchTerm.toLowerCase()} `)
    await expect(page.locator('[data-project]')).toHaveCount(1)
    const projectTitle = page.getByRole('link', { name: title, exact: true })
    await expect(projectTitle).toBeVisible()
    await expect(projectTitle).toHaveAttribute('title', title)
    expect((await projectTitle.boundingBox())!.width).toBeLessThan(width - 40)
    await page.screenshot({ path: test.info().outputPath('project-search-mobile.png') })
    await controls[0]!.fill('没有匹配的标题')
    await expect(
      page.getByText('没有标题包含「没有匹配的标题」的项目', { exact: true }),
    ).toBeVisible()
    await controls[0]!.fill('abcdefghij'.repeat(40))
    const empty = page.locator('.ui-empty-title')
    await expect(empty).toContainText('没有标题包含')
    expect(
      await empty.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.x >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth
      }),
    ).toBe(true)
    await controls[0]!.fill('')
    await expect(page.locator('[data-project]')).toHaveCount(count)
  })
}
