import { expect, test } from './fixtures'
import { newProject } from './canvas'

test.describe('已删除目标的导航恢复', { tag: '@core' }, () => {
  test('打开中的画布被删除后回首页说明原因，后退不重连也不建替代画布', async ({ page }) => {
    // 先过首页：浏览器历史里有首页这一条，后退才回得到首页
    await newProject(page, { visitHome: true })
    const id = new URL(page.url()).hash.split('/').at(-1)!
    const canvas = await (await page.request.get(`/api/canvases/${id}`)).json()
    // 画布打开期间在别处删掉它：同步以 4404 关闭，页面回首页并说明原因
    let connections = 0
    page.on('websocket', (socket) => {
      if (socket.url().includes(id)) connections++
    })
    expect((await page.request.delete(`/api/canvases/${id}`)).ok()).toBe(true)
    await expect(page.getByText('画布不存在或已被删除', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    // 浏览器后退不能把已删除的画布重新连接起来
    const before = connections
    await page.goBack()
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    expect(connections).toBe(before)
    // 不创建替代画布
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
