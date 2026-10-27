import { expect, test } from './fixtures'
import { newProject, waitEngine } from './canvas'

for (const width of [320, 1024, 1440]) {
  test(`${width}px 顶栏工具可达，面板关闭后能继续切换视图`, async ({ page }) => {
    await newProject(page)
    const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
    const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
    const projectName = `很长的项目名称${'雨后水杯'.repeat(15)}`
    await page.request.patch(`/api/projects/${canvas.projectId}`, { data: { title: projectName } })
    await page.request.patch(`/api/canvases/${canvasId}`, {
      data: { title: '很长的画布名称'.repeat(15) },
    })
    await page.reload()
    await waitEngine(page)
    await page.setViewportSize({ width, height: 900 })
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    for (const button of [
      page.getByRole('button', { name: projectName, exact: true }),
      page.getByRole('button', { name: '切换画布', exact: true }),
      page.getByRole('button', { name: '工作流', exact: true }),
    ]) {
      await expect
        .poll(() =>
          button.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return (
              r.x >= 0 &&
              r.right <= innerWidth &&
              el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            )
          }),
        )
        .toBe(true)
    }
    const compact = page.getByRole('button', { name: '画布工具', exact: true })
    await page.getByRole('button', { name: projectName, exact: true }).click()
    const renameDialog = page.getByRole('dialog', { name: '重命名项目', exact: true })
    const rename = renameDialog.getByRole('textbox')
    await expect(rename).toBeFocused()
    expect(
      await rename.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.x >= 0 && r.right <= innerWidth && r.width > 200
      }),
    ).toBe(true)
    await rename.press('Escape')
    await expect(rename).toHaveCount(0)
    if (await compact.isVisible()) await compact.click()
    const settings = page.getByRole(width < 1280 ? 'menuitem' : 'button', {
      name: '设置',
      exact: true,
    })
    const bounds = await settings.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    await settings.click()
    const panel = page.getByRole('dialog', { name: '设置', exact: true })
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await expect(
      page.getByRole('complementary', { name: '侧栏', exact: true, includeHidden: true }),
    ).toBeAttached()
    await page.screenshot({
      path: test.info().outputPath('editor-header.png'),
      animations: 'disabled',
    })
  })
}

test('紧凑工具支持全部面板、主题和窗口放大后的恢复', async ({ page }) => {
  await newProject(page)
  await page.setViewportSize({ width: 390, height: 900 })
  const trigger = page.getByRole('button', { name: '画布工具', exact: true })
  const menu = page.getByRole('menu', { name: '画布工具', exact: true })
  for (const [name, title] of [
    ['素材', '素材'],
    ['检查点', '创作检查点'],
    ['资产库', '资产库'],
  ]) {
    await trigger.click()
    await menu.getByRole('menuitem', { name, exact: true }).click()
    const panel = page.getByRole('dialog', { name: title, exact: true })
    await expect(panel).toBeVisible()
    await expect(menu).not.toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(trigger).toBeFocused()
  }
  await trigger.click()
  await menu.getByRole('menuitemradio', { name: '深色', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(
    page.getByRole('menu', { name: '画布工具', exact: true, includeHidden: true }),
  ).toHaveCount(0)
  await trigger.click()
  await expect(menu).toHaveCSS('opacity', '1')
  await menu.screenshot({
    path: test.info().outputPath('compact-editor-tools.png'),
    animations: 'disabled',
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(menu).not.toBeVisible()
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(menu).not.toBeVisible()
  await trigger.press('Space')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('紧凑工具打开时触发按钮上的撤销不改背景节点', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '原名称',
      params: {},
      x: 400,
      y: 300,
    })
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      undo: { stopCapturing(): void }
    }
    doc.undo.stopCapturing()
    const node = doc.mutable(id) as unknown as { set(key: string, value: unknown): void }
    node.set('name', '保留的修改')
    return id
  })
  await page.setViewportSize({ width: 390, height: 900 })
  const trigger = page.getByRole('button', { name: '画布工具', exact: true })
  await trigger.click()
  const menu = page.getByRole('menu', { name: '画布工具', exact: true })
  await expect(menu).toBeVisible()
  await trigger.focus()
  for (const key of ['Control+z', 'Meta+z', 'Control+y', 'Meta+Shift+z']) {
    await trigger.press(key)
    await expect(menu).toBeVisible()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.name, id)).toBe(
      '保留的修改',
    )
  }
  await page.keyboard.press('Escape')
  await expect(menu).not.toBeVisible()
  await expect(trigger).toBeFocused()
})
