import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

test('连接恢复前目标画布已被删除，恢复后回首页且不创建替代内容', async ({ page }) => {
  await newProject(page)
  const id = new URL(page.url()).hash.split('/').at(-1)!
  const canvas = await (await page.request.get(`/api/canvases/${id}`)).json()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/session', async (route) => {
    await held
    await route.continue()
  })
  try {
    await page.reload()
    await expect(page.getByRole('status').filter({ hasText: '正在连接 Plein' })).toBeVisible()
    expect((await page.request.delete(`/api/canvases/${id}`)).ok()).toBe(true)
    release()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    await expect(page.getByText('画布不存在或已被删除', { exact: true })).toBeVisible()
    await expect(page.locator('.ui-toast[data-closing]')).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('deleted-after-reconnect.png'),
      animations: 'disabled',
    })
    expect(
      (await (await page.request.get(`/api/projects/${canvas.projectId}/canvases`)).json()).length,
    ).toBe(0)
  } finally {
    release()
  }
})

test('正在打开的画布被删除后返回首页，浏览器后退不重新连接已删除画布', async ({ page }) => {
  await newProject(page)
  const id = new URL(page.url()).hash.split('/').at(-1)!
  let connections = 0
  page.on('websocket', (socket) => {
    if (socket.url().includes(id)) connections++
  })
  expect((await page.request.delete(`/api/canvases/${id}`)).ok()).toBe(true)
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
  await expect(page.getByText('画布不存在或已被删除', { exact: true })).toBeVisible()
  const before = connections
  await page.goBack()
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
  expect(connections).toBe(before)
})

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
  await page.screenshot({ path: test.info().outputPath('deleted-project.png') })
  await page.getByRole('link', { name: '回到项目列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
  await expect(page.locator(`[data-project="${project.id}"]`)).toHaveCount(0)
})
