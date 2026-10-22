import { expect, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'

for (const { type, trigger, label } of [
  { type: 'plein/video', trigger: '参数', label: '参数' },
  { type: 'plein/video', trigger: '模型', label: '选择模型' },
]) {
  test(`${type} ${trigger}弹层在编辑器随窗口收起时同步关闭，展开后可重新打开`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(
      (type) =>
        window.__plein.addNode({
          type,
          name: '参数浮层测试',
          params: { prompt: '保留长描述' },
          x: 400,
          y: 200,
        }),
      type,
    )
    await clickElement(page, id)
    await page.evaluate((id) => {
      const engine = window.__plein.engine as Window['__plein']['engine'] & {
        camera: { panBy(x: number, y: number): void }
      }
      const rect = engine.doc.worldRect(id)
      const at = engine.worldToClient(rect.x, rect.y + rect.h / 2)
      engine.camera.panBy(0, 160 - at.y)
    }, id)
    const panel = page.getByTestId('generator')
    await panel.getByRole('button', { name: trigger, exact: true }).click()
    const popover = page.getByRole('dialog', { name: label, exact: true })
    await expect(popover).toBeVisible()
    await page.setViewportSize({ width: 1000, height: 320 })
    await expect(panel).toHaveAttribute('data-compact', 'true')
    await expect(popover).toHaveCount(0)
    await panel.getByRole('button', { name: /^编辑/ }).click()
    await panel.getByRole('button', { name: trigger, exact: true }).click()
    await expect(popover).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(panel.getByRole('button', { name: trigger, exact: true })).toBeFocused()
  })
}
