import { expect, test } from '@playwright/test'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../packages/providers/src/mock/video-fixture'
import { clickElement, newProject, waitEngine } from './canvas'

test('多模态参考按类型编号、插入提示词、重排、预览并在刷新后保留', async ({ page }) => {
  await newProject(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles([
    {
      name: '图一.png',
      mimeType: 'image/png',
      buffer: Buffer.from(solidPng(720, 720, [30, 80, 130])),
    },
    {
      name: '图二.png',
      mimeType: 'image/png',
      buffer: Buffer.from(solidPng(720, 720, [160, 80, 50])),
    },
    { name: '运镜.webm', mimeType: 'video/webm', buffer: Buffer.from(MOCK_WEBM_BASE64, 'base64') },
    { name: '节奏.wav', mimeType: 'audio/wav', buffer: Buffer.from(sineWav(2)) },
  ])
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].filter((el) =>
            ['image', 'video', 'audio'].includes(el.kind),
          ).length,
      ),
    )
    .toBe(4)
  const { id, first, second } = await page.evaluate(() => {
    const all = [...window.__plein.engine.doc.elements()]
    const images = all.filter((el) => el.kind === 'image')
    const id = window.__plein.addNode({
      type: 'plein/video',
      name: '全能参考验收',
      x: 400,
      y: 200,
      params: { model: 'plein/mock:video', mode: 'reference', prompt: '参考' },
    })
    for (const media of all.filter((el) => ['image', 'video', 'audio'].includes(el.kind)))
      window.__plein.connect(
        [media.id, media.kind],
        [id, media.kind === 'video' ? 'videos' : media.kind === 'audio' ? 'audios' : 'images'],
      )
    return { id, first: images[0]!.assetId, second: images[1]!.assetId }
  })
  await clickElement(page, id)
  const generator = page.getByTestId('generator')
  const expand = generator.getByRole('button', { name: /^编辑/ })
  if (await expand.isVisible()) await expand.click()
  for (const token of ['@image1', '@image2', '@video1', '@audio1']) {
    const button = generator.getByRole('button', { name: token, exact: true })
    await expect(button).toBeVisible()
    await button.click()
  }
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.prompt, id))
    .toBe('参考 @image1 @image2 @video1 @audio1 ')
  await expect(generator.locator('mark[data-state="missing"]')).toHaveCount(0)
  const preview = page.getByTestId('input-preview')
  await preview.getByRole('button', { name: /实际输入/ }).click()
  await expect(preview).not.toContainText('不会提交')
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  const input = async () =>
    (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).json()
  expect((await input()).inputs.images.map((v: { assetId: string }) => v.assetId)).toEqual([
    first,
    second,
  ])
  await generator.getByRole('button', { name: '向前移动参考 2', exact: true }).click()
  await expect
    .poll(async () => (await input()).inputs.images.map((v: { assetId: string }) => v.assetId))
    .toEqual([second, first])
  await generator.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(generator.getByRole('button', { name: '@image1', exact: true })).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath('video-reference-inputs.png') })
  await page.reload()
  await waitEngine(page)
  await clickElement(page, id)
  await expect(generator.getByRole('button', { name: '@video1', exact: true })).toBeVisible()
  expect((await input()).inputs.images.map((v: { assetId: string }) => v.assetId)).toEqual([
    second,
    first,
  ])
  expect((await input()).inputs.videos).toHaveLength(1)
  expect((await input()).inputs.audios).toHaveLength(1)
})

test('火山有参考时允许空提示词，并提前禁用仅尾帧模式', async ({ page }) => {
  await newProject(page)
  const configured = await page.request.put('/api/providers/volc/ark/config', {
    data: { enabled: true, secrets: { ARK_API_KEY: 'e2e-local-no-generation' } },
  })
  expect(configured.ok()).toBe(true)
  await page.reload()
  await waitEngine(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (
    await chooser
  ).setFiles({
    name: '空提示词参考.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(720, 720, [50, 100, 150])),
  })
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(1)
  const id = await page.evaluate(() => {
    const image = [...window.__plein.engine.doc.elements()].find((el) => el.kind === 'image')!
    const id = window.__plein.addNode({
      type: 'plein/video',
      name: '火山空提示词',
      x: 400,
      y: 200,
      params: { model: 'volc/ark:doubao-seedance-2-5-260628', mode: 'reference', prompt: '' },
    })
    window.__plein.connect([image.id, 'image'], [id, 'images'])
    return id
  })
  await clickElement(page, id)
  const generator = page.getByTestId('generator')
  const expand = generator.getByRole('button', { name: /^编辑/ })
  if (await expand.isVisible()) await expand.click()
  await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
  await generator.getByRole('button', { name: '生成模式', exact: true }).click()
  await expect(page.getByRole('option').filter({ hasText: '仅尾帧' })).toBeDisabled()
  await page.getByRole('option').filter({ hasText: '图生视频' }).click()
  const canvas = /#\/c\/([^/?]+)/.exec(page.url())![1]
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/canvases/${canvas}/nodes/${id}/input`)).json()).params
          .aspectRatio,
    )
    .toBe('auto')
  await expect(generator.getByRole('button', { name: '生成', exact: true })).toBeEnabled()
  // 只验收本地准备和界面；不点击生成，不调用真实平台。
})
