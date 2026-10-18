import { expect, test } from '@playwright/test'
import { clickElement, newProject } from './canvas'

test('悬停中的生成按钮随任务状态更新提示，移出后不恢复旧说明', async ({ page }) => {
  await newProject(page)
  const config = '/api/providers/plein/mock/config'
  const original = await (await page.request.get(config)).json()
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '动态悬停提示',
      params: { prompt: '透明水杯', model: 'plein/mock:image' },
      x: 400,
      y: 200,
    }),
  )
  const canvas = new URL(page.url()).hash.split('/').at(-1)!
  try {
    expect(
      (
        await page.request.put(config, {
          data: { settings: { ...original.settings, latencyMs: 20000 } },
        })
      ).ok(),
    ).toBe(true)
    await clickElement(page, id)
    const generator = page.getByTestId('generator')
    await generator.getByRole('button', { name: '生成', exact: true }).hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('生成')
    // 从另一入口启动同一节点，指针保持悬停，避免点击隐藏提示掩盖状态变化。
    expect((await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`)).status()).toBe(202)
    const cancel = generator.getByRole('button', { name: '取消', exact: true })
    await expect(cancel).toBeEnabled()
    await expect(tip).toHaveText('取消')
    await page.mouse.move(0, 0)
    await expect(tip).toHaveCount(0)
    await expect(cancel).toHaveAttribute('title', '取消')
    await cancel.hover()
    await expect(tip).toHaveText('取消')
    await cancel.click()
    await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
  } finally {
    await page.request.post(`/api/canvases/${canvas}/nodes/${id}/cancel`)
    await page.request.put(config, { data: { settings: original.settings } })
  }
})
