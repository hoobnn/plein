import { readFileSync } from 'node:fs'
import { expect, test, type Download } from './fixtures'
import { newProject, waitNode } from './canvas'

test('历史下载失败重试只交出原文件，名称与字节一致 @core', async ({ page }) => {
  await newProject(page)
  const ids = await page.evaluate(() => [
    window.__plein.addNode({
      type: 'plein/image',
      name: '历史图片',
      params: { model: 'plein/mock:image', prompt: '红色杯子' },
      x: 300,
      y: 200,
    }),
    window.__plein.addNode({
      type: 'plein/speech',
      name: '历史音频',
      params: { model: 'plein/mock:audio', text: '你好' },
      x: 800,
      y: 200,
    }),
  ])
  const canvas = decodeURIComponent(page.url().split('#/c/')[1]!)
  for (const id of ids) {
    await expect
      .poll(async () =>
        (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).status(),
      )
      .toBe(200)
    expect(
      (await page.request.post(`/api/canvases/${canvas}/nodes/${id}/run`, { data: {} })).status(),
    ).toBe(202)
    await waitNode(page, id)
  }
  const assets = await page.evaluate(
    (ids) =>
      ids.map((id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string),
    ids,
  )
  const bytes = await Promise.all(
    assets.map(async (id) => (await page.request.get(`/api/assets/${id}`)).body()),
  )
  let fail = true
  const requests = [0, 0]
  await page.route('**/api/assets/*', async (route) => {
    const index = assets.indexOf(route.request().url().split('/').at(-1)!)
    if (index < 0 || route.request().resourceType() !== 'fetch') return route.continue()
    requests[index]!++
    return index === 0 && fail
      ? route.fulfill({ status: 503, body: 'unavailable' })
      : route.continue()
  })
  await page.setViewportSize({ width: 390, height: 640 })
  await page.getByRole('button', { name: '生成历史', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '生成历史', exact: true })
  await panel.getByRole('checkbox').first().check()
  await panel.getByRole('button', { name: '全选', exact: true }).click()
  const files: Download[] = []
  page.on('download', (file) => files.push(file))
  await panel.getByRole('button', { name: '下载', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '1 个文件读取失败' })).toBeVisible()
  fail = false
  await panel.getByRole('button', { name: '重试未下载（1）', exact: true }).click()
  await expect.poll(() => files.length).toBe(2)
  for (const file of files) {
    expect(await file.failure()).toBeNull()
    const index = file.suggestedFilename().startsWith('历史图片') ? 0 : 1
    expect(file.suggestedFilename()).toBe(index === 0 ? '历史图片-2.png' : '历史音频-1.wav')
    expect(readFileSync((await file.path())!)).toEqual(bytes[index])
  }
  expect(requests).toEqual([2, 1])
  await expect(panel.getByRole('status').filter({ hasText: '已交给浏览器下载' })).toBeVisible()
})
