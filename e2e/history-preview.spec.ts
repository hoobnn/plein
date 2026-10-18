import { expect, test } from '@playwright/test'
import { newProject, waitNode } from './canvas'

for (const action of ['escape', 'locate'] as const) {
  test(`历史审片 ${action} 按浮层层级退出并保留明确采用`, async ({ page }) => {
    await newProject(page)
    const id = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/image',
        name: '历史候选审片',
        params: { model: 'plein/mock:image', prompt: '两个水杯', count: 2 },
        x: 400,
        y: 300,
      }),
    )
    const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    expect(
      (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
    ).toBe(202)
    await waitNode(page, id)
    const before = await page.evaluate(
      (id) => ({
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
        results: window.__plein.engine.doc.get(id)!.results!,
      }),
      id,
    )
    expect(before.results).toHaveLength(2)
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const history = page.getByRole('dialog', { name: '生成历史', exact: true })
    await history.getByRole('listitem').last().getByRole('button').first().click()
    const viewer = page.getByRole('dialog', { name: '查看「历史候选审片」', exact: true })
    await expect(viewer).toBeVisible()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
    ).toEqual(before.adopted)
    await expect(viewer.getByRole('button', { name: '采用此候选', exact: true })).toBeEnabled()
    if (action === 'escape') {
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      await expect(history).toBeVisible({ timeout: 1500 })
      await expect(history.getByRole('checkbox', { checked: true })).toHaveCount(0)
      await history.getByRole('listitem').last().getByRole('button').first().click()
      await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
      ).toBe(before.results[1]!.id)
      await viewer.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(history).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(history).toHaveCount(0)
    } else {
      await viewer.getByRole('button', { name: '定位来源', exact: true }).click()
      await expect(viewer).toHaveCount(0)
      await expect(history).toHaveCount(0, { timeout: 1500 })
      expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
    }
    await page.screenshot({
      path: test.info().outputPath('history-preview-exit.png'),
      animations: 'disabled',
    })
  })
}
