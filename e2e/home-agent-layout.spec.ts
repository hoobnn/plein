import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

test('窄屏筛选卡片的标题右侧可点击，不被助手开关截获', async ({ page }) => {
  await newProject(page)
  const title = `助手遮挡检查 ${Date.now()}`
  const project = await (await page.request.post('/api/projects', { data: { title } })).json()
  await page.goto('/')
  await page.setViewportSize({ width: 320, height: 800 })
  await page.getByRole('searchbox', { name: '搜索项目', exact: true }).fill(title)
  const link = page.getByRole('link', { name: title, exact: true })
  await expect(link).toBeVisible()
  const r = (await link.boundingBox())!
  await page.mouse.click(r.x + r.width - 8, r.y + r.height / 2)
  await waitEngine(page)
  expect(new URL(page.url()).hash).toBe(`#/c/${project.lastCanvasId}`)
  await expect(page.getByRole('complementary', { name: '助手', exact: true })).toHaveCount(0)
})

for (const width of [320, 1440]) {
  test(`${width}px 首页助手不覆盖项目卡片，开关后焦点归还且入口唯一`, async ({ page }) => {
    await newProject(page)
    const original = new URL(page.url()).hash
    await page.goto('/')
    await page.setViewportSize({ width, height: 800 })
    const trigger = page.getByRole('button', { name: '打开助手', exact: true })
    await expect(trigger).toHaveCount(1)
    // 入口置于页面工具栏，滚动项目内容不会使它盖在卡片上。
    await expect(
      page.getByRole('banner').getByRole('button', { name: '打开助手', exact: true }),
    ).toBeVisible()
    expect(
      await trigger.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return (
          r.x >= 0 &&
          r.right <= innerWidth &&
          el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        )
      }),
    ).toBe(true)
    await trigger.click()
    const panel = page.getByRole('complementary', { name: '助手', exact: true })
    await expect(panel).toContainText('打开一块画布，我就能帮你搭工作流')
    await expect(page.getByRole('button', { name: '收起助手', exact: true })).toHaveCount(1)
    await panel.getByRole('button', { name: '关闭', exact: true }).press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(trigger).toBeFocused()
    await page.screenshot({
      path: test.info().outputPath('home-agent-toolbar.png'),
      animations: 'disabled',
    })
    // 回到画布仍使用原有画布入口，随后返回首页也不能残留第二个悬浮开关。
    await page.evaluate((hash) => {
      location.hash = hash
    }, original)
    await waitEngine(page)
    await expect(page.getByRole('button', { name: '打开助手', exact: true })).toHaveCount(1)
    await page.evaluate(() => {
      location.hash = '/'
    })
    await expect(
      page.getByRole('banner').getByRole('button', { name: '打开助手', exact: true }),
    ).toBeVisible()
    await expect(trigger).toHaveCount(1)
  })
}
