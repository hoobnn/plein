import { expect, type Page, test } from '@playwright/test'
import { byName, elements, newProject, waitEngine, waitNode } from './canvas'

async function image(page: Page, name: string) {
  const nodeId = await page.evaluate(
    (name) =>
      window.__plein.addNode({
        type: 'plein/image',
        name,
        params: { prompt: '海边的一只白色海鸟', model: 'plein/mock:image' },
        x: 0,
        y: 0,
      }),
    name,
  )
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  await expect
    .poll(async () => {
      const result = await page.request.post(`/api/canvases/${canvasId}/nodes/${nodeId}/run`, {
        data: {},
      })
      return result.status()
    })
    .toBe(202)
  await waitNode(page, nodeId)
  return { nodeId, canvasId }
}

test('跨项目素材能预览、放入新画布和存为语义资产，不再次生成', async ({ page }, testInfo) => {
  await newProject(page)
  const source = await image(page, '素材检索专用海鸟')
  const assetId = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string,
    source.nodeId,
  )
  await newProject(page)
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('combobox', { name: '关联项目' }).click()
  await page.getByRole('option', { name: '全部项目', exact: true }).click()
  await panel.getByRole('searchbox', { name: '搜索素材' }).fill('素材检索专用海鸟')
  await panel
    .getByRole('button', { name: /查看素材 / })
    .first()
    .click()
  await expect(panel.getByRole('button', { name: '放入当前画布' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('media-library.png') })
  await panel.getByRole('button', { name: '放大查看素材' }).click()
  const preview = page.getByRole('dialog', { name: '素材预览' })
  await expect(preview.locator('img')).toBeVisible()
  await preview.getByRole('button', { name: '放大', exact: true }).click()
  await expect(preview).toContainText('125%')
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  await panel.getByRole('button', { name: '放入当前画布' }).click()
  await expect(panel).toBeHidden()
  await expect
    .poll(async () =>
      page.evaluate(
        (assetId) =>
          [...window.__plein.engine.doc.elements()].filter((el) => el.assetId === assetId).length,
        assetId,
      ),
    )
    .toBe(1)
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const reopened = page.getByRole('dialog', { name: '素材', exact: true })
  await reopened
    .getByRole('button', { name: /查看素材 / })
    .first()
    .click()
  await reopened.getByRole('button', { name: '存入资产库', exact: true }).click()
  const library = page.getByRole('dialog', { name: '资产库', exact: true })
  await library.getByLabel('名称', { exact: true }).fill('检索海鸟角色')
  await library.getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(async () => {
      const items = (await (await page.request.get('/api/library')).json()) as Array<{
        name: string
        images: Array<{ assetId: string }>
      }>
      return items.find((item) => item.name === '检索海鸟角色')?.images[0]?.assetId
    })
    .toBe(assetId)
})

test('命名检查点预览只读且恢复新画布保留原版本，原画布继续保留修改', async ({ page }, testInfo) => {
  await newProject(page)
  const source = await image(page, '检查点海鸟镜头')
  const before = await elements(page)
  let attempts = 0
  const submitted: string[] = []
  let release = () => {}
  const retryGate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/canvases/*/checkpoints', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    attempts++
    submitted.push(route.request().postDataJSON().expectedSnapshot as string)
    if (attempts === 1)
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'sync_pending', message: '等待同步' }),
      })
    await retryGate
    await route.continue()
  })
  await page.getByRole('button', { name: '检查点', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '创作检查点' })
  await panel.getByRole('textbox', { name: '检查点名称' }).fill('第一版审核通过')
  await panel.getByRole('button', { name: '保存当前画布' }).click()
  await expect(panel.getByRole('status')).toContainText('正在等待本机编辑同步')
  release()
  await expect(panel.getByTestId('checkpoint-preview').locator('canvas')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('checkpoints.png') })
  expect(submitted).toHaveLength(2)
  expect(submitted[0]).toBe(submitted[1])
  await panel.getByTestId('checkpoint-preview').locator('canvas').click()
  await page.keyboard.press('Delete')
  expect(await elements(page)).toEqual(before)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate((id) => {
    const params = window.__plein.engine.doc.mutable(id)!.get('params') as {
      set(key: string, value: string): void
    }
    params.set('prompt', '保存后的第二版提示词')
  }, source.nodeId)
  await page.getByRole('button', { name: '检查点', exact: true }).click()
  const again = page.getByRole('dialog', { name: '创作检查点' })
  await again.getByRole('button', { name: '恢复为新画布' }).click()
  await expect(page).not.toHaveURL(new RegExp(source.canvasId))
  await waitEngine(page)
  const restored = await byName(page, '检查点海鸟镜头')
  expect(restored.results).toBe(1)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, restored.id),
  ).toBe('海边的一只白色海鸟')
  const newCanvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const jobs = (await (await page.request.get(`/api/canvases/${newCanvasId}/jobs`)).json()) as {
    jobs: Array<{ status: string }>
  }
  expect(jobs.jobs.every((job) => job.status !== 'queued' && job.status !== 'running')).toBe(true)
  await page.goto(`/#/c/${source.canvasId}`)
  await waitEngine(page)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.prompt, source.nodeId),
  ).toBe('保存后的第二版提示词')
})
