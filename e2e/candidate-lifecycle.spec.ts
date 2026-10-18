import { expect, test } from '@playwright/test'
import { clickElement, newProject, waitEngine, waitNode } from './canvas'

for (const kind of ['image', 'video'] as const) {
  test(`${kind} 连续生成候选后，卡片浏览、采用、撤销重做与刷新保持一致`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(
      (kind) =>
        window.__plein.addNode({
          type: `plein/${kind}`,
          name: '候选生命周期',
          params: { prompt: '雨后透明水杯', model: `plein/mock:${kind}` },
          x: 400,
          y: 300,
        }),
      kind,
    )
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '生成', exact: true }).click()
    await waitNode(page, id)
    await generator.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect
      .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
      .toBe(2)
    const adopted = () =>
      page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted') as string, id)
    const original = await adopted()
    await page
      .locator('.plein-node')
      .getByRole('button', { name: '下一个结果', exact: true })
      .click()
    const viewer = page.getByRole('dialog', { name: '查看「候选生命周期」', exact: true })
    const adopt = viewer.getByRole('button', { name: '采用此候选', exact: true })
    await expect(adopt).toBeEnabled()
    expect(await adopted()).toBe(original)
    await adopt.click()
    const chosen = await adopted()
    expect(chosen).not.toBe(original)
    if (kind === 'image') {
      const image = viewer.getByRole('img', { name: '候选生命周期', exact: true })
      await expect(image).toBeVisible()
      await expect
        .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0)
    } else {
      const video = viewer.locator('video')
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState))
        .toBeGreaterThanOrEqual(2)
    }
    await viewer.screenshot({
      path: test.info().outputPath('candidate-preview.png'),
      animations: 'disabled',
    })
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(adopted).toBe(original)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect.poll(adopted).toBe(chosen)
    const expectedCount = await page.evaluate((id) => {
      const el = window.__plein.engine.doc.get(id)!
      return `${el.results!.findIndex((result) => result.id === (window.__plein.engine.doc.mutable(id)?.get('adopted') as string)) + 1}/2`
    }, id)
    await expect(page.locator('.plein-node-count')).toHaveText(expectedCount)
    await page.reload()
    await waitEngine(page)
    await expect.poll(adopted).toBe(chosen)
    await clickElement(page, id)
    await generator.getByRole('button', { name: '全屏查看', exact: true }).click()
    await expect(viewer.getByRole('button', { name: '已采用', exact: true })).toBeDisabled()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id),
    ).toBe(2)
  })
}
