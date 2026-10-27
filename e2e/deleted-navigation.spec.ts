import { expect, test } from './fixtures'
import { newProject } from './canvas'

test.describe('已删除目标的导航恢复', { tag: '@core' }, () => {
  test('旧画布链接清楚说明已删除并返回首页，不创建替代画布', async ({ page }) => {
    await newProject(page)
    const id = new URL(page.url()).hash.split('/').at(-1)!
    const canvas = await (await page.request.get(`/api/canvases/${id}`)).json()
    await page.goto('/')
    expect((await page.request.delete(`/api/canvases/${id}`)).ok()).toBe(true)
    await page.goto(`/#/c/${id}`)
    await expect(page.getByText('画布不存在或已被删除', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    expect(
      (await (await page.request.get(`/api/projects/${canvas.projectId}/canvases`)).json()).length,
    ).toBe(0)
  })

  test('已删除项目链接显示具体错误和返回入口，不提供无效的重新打开', async ({ page }) => {
    const project = await (
      await page.request.post('/api/projects', { data: { title: '已删除的链接目标' } })
    ).json()
    expect((await page.request.delete(`/api/projects/${project.id}`)).ok()).toBe(true)
    await page.goto(`/#/p/${project.id}`)
    await expect(page.getByRole('alert')).toContainText('项目不存在')
    await expect(page.getByRole('button', { name: '重新打开', exact: true })).toHaveCount(0)
    await page.getByRole('link', { name: '回到项目列表', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    await expect(page.locator(`[data-project="${project.id}"]`)).toHaveCount(0)
  })
})
