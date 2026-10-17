import { expect, test } from '@playwright/test'
import { centerOf, clickElement, handleOf, newProject } from './canvas'

test('低高度窗口选中文本后输出端口仍可直接拖线', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 320 })
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/text',
      name: '保留编辑内容',
      params: { text: '正文不丢失' },
      x: 400,
      y: 200,
    }),
  )
  await clickElement(page, id)
  const at = await handleOf(page, id, 'out')
  expect(await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName, at)).toBe(
    'CANVAS',
  )
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(950, 150, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByRole('dialog', { name: '添加节点', exact: true })).toBeVisible()
})

for (const type of [
  'plein/text',
  'plein/image',
  'plein/video',
  'plein/character',
  'plein/scene',
  'plein/prop',
]) {
  test(`${type} 紧凑入口可展开编辑、收起和随窗口切换，正文及选区保留`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 320 })
    await newProject(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const id = await page.evaluate(
      (type) => window.__plein.addNode({ type, name: '布局测试', params: {}, x: 400, y: 200 }),
      type,
    )
    await clickElement(page, id)
    const panel = page.getByTestId('generator')
    await expect(panel).toHaveAttribute('data-compact', 'true')
    const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
    await panel.getByRole('button', { name: /^编辑/ }).click()
    const prompt = panel.getByRole('textbox', { name: '提示词', exact: true })
    await expect(prompt).toBeFocused()
    await prompt.fill('编辑后保留中文和 emoji 🌧️')
    await panel.getByRole('button', { name: '收起编辑器' }).click()
    await expect(panel).toHaveAttribute('data-compact', 'true')
    await expect(prompt).toBeHidden()
    for (const side of ['in', 'out'] as const) {
      const at = await handleOf(page, id, side)
      expect(await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName, at)).toBe(
        'CANVAS',
      )
    }
    const center = await centerOf(page, id)
    await page.mouse.dblclick(center.x, center.y)
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('编辑后保留中文和 emoji 🌧️')
    await panel.getByRole('button', { name: '收起编辑器' }).click()
    await page.setViewportSize({ width: 1000, height: 900 })
    await expect(panel).toHaveAttribute('data-compact', 'false')
    await expect(prompt).toHaveValue('编辑后保留中文和 emoji 🌧️')
    await page.setViewportSize({ width: 1000, height: 320 })
    await expect(panel).toHaveAttribute('data-compact', 'true')
    await page.screenshot({ path: `test-results/generator-compact-${type.split('/')[1]}.png` })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    const close = settings.getByRole('button', { name: '关闭', exact: true })
    await close.focus()
    await page.evaluate(
      (id) => window.dispatchEvent(new CustomEvent('plein:focus-generator', { detail: id })),
      id,
    )
    await expect(close).toBeFocused()
    await expect(panel).toHaveAttribute('data-compact', 'true')
    await close.click()
    await expect(settings).toHaveCount(0)
    await panel.getByRole('button', { name: /^编辑/ }).click()
    await expect(prompt).toHaveValue('编辑后保留中文和 emoji 🌧️')
    expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(before)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
    expect(errors).toEqual([])
  })
}
