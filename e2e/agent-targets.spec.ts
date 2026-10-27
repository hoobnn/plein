import { expect, test } from './fixtures'
import { centerOf, elements, newProject, settle } from './canvas'

test('工具记录随元素重命名、删除和撤销同步摘要与定位，展开结果保留', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  await panel.getByPlaceholder('让小满帮你做点什么…').fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const id = (await elements(page)).find((e) => e.nodeType === 'plein/image')!.id
  const summary = panel.getByRole('button', { name: /^运行节点/ })
  const tool = summary.locator('..').locator('..')
  await summary.click()
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  await expect(tool.locator('pre')).toBeVisible()
  await page.evaluate((id) => {
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: string): void
    }
    node.set('name', '重命名后的生成节点')
  }, id)
  await expect(summary).toContainText('重命名后的生成节点')
  const locate = tool.getByRole('button', { name: '在画布上定位', exact: true })
  const changes = panel.getByRole('button', { name: '在画布上查看改动', exact: true })
  await expect(changes).toBeVisible()
  await locate.click()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(false)
  await expect(locate).toHaveCount(0)
  await expect(changes).toHaveCount(0)
  await expect(summary).toContainText('重命名后的生成节点（已删除）')
  await expect(tool.locator('pre')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(true)
  await expect(locate).toBeVisible()
  await expect(changes).toBeVisible()
  await expect(summary).not.toContainText('已删除')
  await locate.click()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  await page.screenshot({
    path: test.info().outputPath('agent-target-restored.png'),
    animations: 'disabled',
  })
})

test('修改方案定位随删除和撤销恢复，恢复后能定位远离视口的目标', async ({ page }) => {
  await newProject(page)
  await page.getByRole('button', { name: '打开助手', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '助手', exact: true })
  const input = panel.getByPlaceholder('让小满帮你做点什么…')
  await input.fill('画一张雨夜天台')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('【mock】好了')).toBeVisible()
  const id = (await elements(page)).find((e) => e.nodeType === 'plein/image')!.id
  await input.fill('让画面更紧张')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  const card = panel.locator('.plein-edit-plan')
  const locate = card.getByRole('button', { name: '在画布上查看', exact: true })
  await expect(locate).toBeVisible()
  await page.evaluate((id) => window.__plein.engine.selection.set([id]), id)
  await page
    .locator('canvas')
    .first()
    .evaluate((canvas) => (canvas.parentElement as HTMLElement).focus())
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(false)
  await expect(locate).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await elements(page)).some((e) => e.id === id)).toBe(true)
  await expect(locate).toBeVisible()
  await page.evaluate(() =>
    (
      window.__plein.engine as unknown as { camera: { panBy(x: number, y: number): void } }
    ).camera.panBy(-2500, 0),
  )
  await locate.click()
  await settle(page, id)
  const point = await centerOf(page, id)
  expect(point.x).toBeGreaterThan(296)
  expect(point.x).toBeLessThan(1016)
  await page.screenshot({
    path: test.info().outputPath('agent-plan-target-restored.png'),
    animations: 'disabled',
  })
})
