import { expect, test } from '@playwright/test'
import { article, checkpointPair, panel } from './checkpoints'

test('反复打开关闭和切换检查点预览，不破坏主画布及其他预览的渲染资源', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await checkpointPair(page)
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const [checkpoint, text] of [
      [f.first, '第一版正文'],
      [f.second, '第二版正文'],
    ] as const) {
      await article(page, checkpoint.name)
        .getByRole('button', { name: '只读预览', exact: true })
        .click()
      const preview = panel(page).getByTestId('checkpoint-preview')
      await expect(preview).toContainText(text)
      const fit = preview.getByRole('button', { name: '适应画布', exact: true })
      await expect(fit).toBeEnabled()
      await fit.click()
      await expect(preview.locator('canvas')).toHaveCount(1)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      expect(errors).toEqual([])
    }
    if (cycle === 2)
      await panel(page).screenshot({
        path: test.info().outputPath('checkpoint-render-active.png'),
        animations: 'disabled',
      })
    await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await page.evaluate(() => {
      const engine = window.__plein.engine
      engine.selection.set([...engine.doc.elements()].map((el) => el.id))
      engine.zoomToFit()
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    expect(errors).toEqual([])
    await page.getByRole('button', { name: '检查点', exact: true }).click()
  }
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  expect(errors).toEqual([])
})
