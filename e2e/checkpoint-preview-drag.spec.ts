import { expect, test } from '@playwright/test'
import { article, checkpointPair, panel } from './checkpoints'

for (const source of ['卡片', '空白处']) {
  test(`只读检查点从${source}左键拖动可平移，恢复适应后内容回到视野且原画布不变`, async ({
    page,
  }) => {
    const f = await checkpointPair(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await article(page, f.second.name)
      .getByRole('button', { name: '只读预览', exact: true })
      .click()
    const preview = panel(page).getByTestId('checkpoint-preview')
    const label = preview.getByText('预览原稿 第二版正文', { exact: true })
    await expect(label).toBeVisible()
    const canvas = (await preview.locator('canvas').boundingBox())!
    const before = (await label.boundingBox())!
    const start =
      source === '卡片'
        ? { x: before.x + before.width / 2, y: before.y + before.height / 2 + 40 }
        : { x: canvas.x + 80, y: canvas.y + 80 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 80, start.y + 45, { steps: 5 })
    await expect
      .poll(async () => {
        const after = await label.boundingBox()
        return (
          !!after && Math.abs(after.x - before.x - 80) < 2 && Math.abs(after.y - before.y - 45) < 2
        )
      })
      .toBe(true)
    await page.mouse.up()
    await preview.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect
      .poll(async () => {
        const restored = await label.boundingBox()
        return (
          !!restored && Math.abs(restored.x - before.x) < 1 && Math.abs(restored.y - before.y) < 1
        )
      })
      .toBe(true)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(errors).toEqual([])
  })
}
