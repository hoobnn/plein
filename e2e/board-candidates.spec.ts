import { expect, test } from './fixtures'
import { newProject, waitNode } from './canvas'

test('故事板预览保留节点候选，切换不误采用，采用后卡片刷新', async ({ page }) => {
  await newProject(page)
  const id = await page.evaluate(() =>
    window.__plein.addNode({
      type: 'plein/image',
      name: '故事板水杯候选',
      params: { model: 'plein/mock:image', prompt: '四种不同的水杯', count: 4 },
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
      results: window.__plein.engine.doc.get(id)!.results!,
      adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
    }),
    id,
  )
  expect(before.results).toHaveLength(4)
  await page.evaluate((id) => {
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    const results = window.__plein.engine.doc.get(id)!.results!.map((result, index) => ({
      ...result,
      outputGroup: `board-candidate-${index}`,
    }))
    node.set('results', [
      ...results,
      {
        ...results[0],
        id: 'metadata-output',
        port: 'metadata',
        value: { type: 'text', text: '说明' },
      },
    ])
  }, id)
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  const card = page.getByRole('button', { name: '查看故事板水杯候选', exact: true })
  await expect(card.getByLabel('4 个候选', { exact: true })).toBeVisible()
  await card.click()
  const viewer = page.getByRole('dialog', { name: '查看「故事板水杯候选」', exact: true })
  await expect(viewer.getByRole('group', { name: '候选审片操作', exact: true })).toBeVisible()
  await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
  await expect(viewer.locator('img').first()).toHaveAttribute(
    'src',
    `/api/assets/${before.results[1]!.value.assetId}`,
  )
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
  ).toBe(before.adopted)
  await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(card.locator('img')).toHaveAttribute(
    'src',
    `/api/assets/${before.results[1]!.value.assetId}/thumb-1024`,
  )
  await card.click()
  await expect(viewer.locator('img').first()).toHaveAttribute(
    'src',
    `/api/assets/${before.results[1]!.value.assetId}`,
  )
  await expect(viewer.getByRole('button', { name: '已采用', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await page.evaluate((id) => {
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('adopted', 'metadata-output')
  }, id)
  await expect(card.locator('img')).toHaveAttribute(
    'src',
    `/api/assets/${before.results[0]!.value.assetId}/thumb-1024`,
  )
  await card.click()
  await expect(viewer.locator('img').first()).toHaveAttribute(
    'src',
    `/api/assets/${before.results[0]!.value.assetId}`,
  )
  await expect(viewer).toHaveCSS('opacity', '1')
  await viewer.screenshot({
    path: test.info().outputPath('board-candidates.png'),
    animations: 'disabled',
  })
  await page.evaluate((id) => {
    const node = window.__plein.engine.doc.mutable(id) as unknown as {
      set(key: string, value: unknown): void
    }
    node.set('name', '已重命名水杯')
  }, id)
  const renamed = page.getByRole('dialog', { name: '查看「已重命名水杯」', exact: true })
  await expect(renamed).toBeVisible()
  await renamed.getByRole('button', { name: '定位来源', exact: true }).click()
  await expect(renamed).toHaveCount(0)
  await expect(page.getByRole('region', { name: '图片', exact: true })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '侧栏', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
  await page.getByRole('button', { name: '故事板', exact: true }).click()
  await page.getByRole('button', { name: '查看已重命名水杯', exact: true }).click()
  await expect(renamed).toBeVisible()
  await page.evaluate((id) => {
    const engine = window.__plein.engine as typeof window.__plein.engine & {
      deleteSelection(): void
    }
    engine.selection.set([id])
    engine.deleteSelection()
  }, id)
  await expect(
    renamed.getByText('来源节点已删除，恢复节点后可继续审片。', { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(renamed).toHaveCount(0)
  await expect(page.getByText('画布上还没有内容', { exact: true })).toBeVisible()
})
