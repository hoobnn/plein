import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

for (const path of ['/c/%E0%A4%A']) {
  test(`不完整或无效地址 ${path} 显示恢复入口，返回首页可继续使用`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/#${path}`)
    await expect(page.getByRole('alert')).toContainText('链接格式不正确')
    await page.screenshot({ path: test.info().outputPath('invalid-link.png') })
    await page.getByRole('link', { name: '回到项目列表', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('画布已打开时切入无效编码地址不会遗留旧画布，随后仍能返回原画布', async ({ page }) => {
  await newProject(page)
  const original = new URL(page.url()).hash
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.evaluate(() => {
    location.hash = '/c/%ED%A0%80'
  })
  await expect(page.getByRole('alert')).toContainText('链接格式不正确')
  await expect(page.locator('canvas')).toHaveCount(0)
  await page.getByRole('link', { name: '回到项目列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible()
  await page.evaluate((hash) => {
    location.hash = hash
  }, original)
  await waitEngine(page)
  expect(new URL(page.url()).hash).toBe(original)
  expect(errors).toEqual([])
})

for (const kind of ['p']) {
  test(`合法 ${kind} 链接保留末尾斜线与查询参数时仍打开正确画布`, async ({ page }) => {
    await newProject(page)
    const canvasId = new URL(page.url()).hash.split('/').at(-1)!
    const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
    await page.goto(`/#/${kind}/${encodeURIComponent(canvas.projectId)}/?source=link`)
    await waitEngine(page)
    await expect(page.getByRole('button', { name: '切换画布', exact: true })).toHaveText(
      canvas.title,
    )
    expect(new URL(page.url()).hash.split('?')[0]!.replace(/\/$/, '')).toBe(`#/c/${canvasId}`)
  })
}
