import { expect, test } from '@playwright/test'
import { newProject } from './canvas'

for (const [width, height] of [
  [320, 320],
  [639, 640],
  [1440, 640],
] as const) {
  test(`${width}x${height}px 空画布提示在可见画布内，可双击添加并撤销回空态`, async ({ page }) => {
    await newProject(page)
    await page.setViewportSize({ width, height })
    const prompt = page.getByText('双击空白处或按 Tab 添加节点', { exact: true })
    await expect(prompt).toBeVisible()
    const hint = prompt.locator('..')
    const sidebar = page.getByRole('complementary', {
      name: '侧栏',
      exact: true,
      includeHidden: true,
    })
    await expect(sidebar).toHaveAttribute('aria-hidden', width < 604 ? 'true' : 'false')
    const side =
      (await sidebar.getAttribute('aria-hidden')) === 'true'
        ? 0
        : (await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width
    const box = (await hint.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(side)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y).toBeGreaterThanOrEqual(64)
    expect(box.y + box.height).toBeLessThanOrEqual(height - 64)
    expect(
      await hint.evaluate(
        (el, left) =>
          [...el.querySelectorAll('p')].every((p) => {
            const r = p.getBoundingClientRect()
            return r.x >= left && r.right <= innerWidth
          }),
        side,
      ),
    ).toBe(true)
    await page.screenshot({
      path: test.info().outputPath('empty-canvas-hint.png'),
      animations: 'disabled',
    })
    const point = (await prompt.boundingBox())!
    await page.mouse.dblclick(point.x + point.width / 2, point.y + point.height / 2)
    const picker = page.getByRole('dialog', { name: '添加节点', exact: true })
    await picker.getByRole('textbox', { name: '搜索节点', exact: true }).fill('文本')
    await picker.getByRole('option', { name: '文本', exact: true }).click()
    await expect(prompt).toHaveCount(0)
    await page.evaluate(() =>
      (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
    )
    await expect(prompt).toBeVisible()
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    await expect(prompt).toHaveCount(0)
    await expect(page.getByText('画布上还没有内容', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await expect(prompt).toBeVisible()
  })
}

test('侧栏覆盖和任务面板改变可用空间时，空态提示隐藏或避让后可恢复', async ({ page }) => {
  await newProject(page)
  await page.setViewportSize({ width: 320, height: 640 })
  const prompt = page.getByText('双击空白处或按 Tab 添加节点', { exact: true })
  await expect(prompt).toBeVisible()
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await expect(prompt).toHaveCount(0)
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await expect(prompt).toBeVisible()
  await page.setViewportSize({ width: 768, height: 640 })
  await page.getByRole('button', { name: '任务', exact: true }).click()
  const tasks = page.getByRole('complementary', { name: '任务', exact: true })
  await expect(tasks).toBeVisible()
  await expect
    .poll(async () => {
      const text = await prompt.locator('..').boundingBox()
      const panel = await tasks.boundingBox()
      return !!text && !!panel && text.x + text.width <= panel.x
    })
    .toBe(true)
  for (const width of [639, 390]) {
    await page.setViewportSize({ width, height: 640 })
    await expect(prompt).toHaveCount(0)
  }
  await tasks.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(prompt).toBeVisible()
})

for (const width of [320]) {
  test(`${width}px 本地演示离线时顶栏可操作，空态支持添加文档和返回`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.abort('internetdisconnected'),
    )
    await page.setViewportSize({ width, height: 640 })
    await page.goto('/#/demo?n=0')
    await expect
      .poll(async () => ({ ready: await page.evaluate(() => !!window.__plein), errors }))
      .toEqual({ ready: true, errors: [] })
    const board = page.getByRole('button', { name: '故事板', exact: true })
    const bounds = (await board.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    await page.screenshot({
      path: test.info().outputPath('offline-demo-empty.png'),
      animations: 'disabled',
    })
    await board.click()
    await expect(page.getByText('画布上还没有内容', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    const prompt = page.getByText('双击空白处或按 Tab 添加节点', { exact: true })
    await expect(prompt).toBeVisible()
    const point = (await prompt.boundingBox())!
    await expect
      .poll(() =>
        page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, {
          x: point.x + point.width / 2,
          y: point.y + point.height / 2,
        }),
      )
      .toBe('CANVAS')
    await page.mouse.dblclick(point.x + point.width / 2, point.y + point.height / 2)
    const picker = page.getByRole('dialog', { name: '添加节点', exact: true })
    await picker.getByRole('textbox', { name: '搜索节点', exact: true }).fill('Markdown')
    await picker.getByRole('option', { name: 'Markdown', exact: true }).click()
    await expect(prompt).toHaveCount(0)
    await page.evaluate(() =>
      (window.__plein.engine as typeof window.__plein.engine & { undo(): void }).undo(),
    )
    await expect(prompt).toBeVisible()
    expect(errors).toEqual([])
  })
}
