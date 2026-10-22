import { execFileSync } from 'node:child_process'
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

test(
  '跨项目素材能预览、放入新画布和存为语义资产，不再次生成',
  { tag: '@core' },
  async ({ page }, testInfo) => {
    await newProject(page)
    const source = await image(page, '素材检索专用海鸟')
    const assetId = await page.evaluate(
      (id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string,
      source.nodeId,
    )
    await newProject(page)
    const blocker = await page.evaluate(() => {
      const view = (
        window.__plein.engine as unknown as {
          camera: { viewRect: { x: number; y: number; w: number; h: number } }
        }
      ).camera.viewRect
      return window.__plein.addNode({
        type: 'plein/text',
        name: '视口中心的原有内容',
        params: { text: '复用素材不能覆盖这里，也不能把这张卡一起撤销' },
        x: view.x + view.w / 2 - 100,
        y: view.y + view.h / 2 - 100,
      })
    })
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
    const imported = await page.evaluate((assetId) => {
      const e = window.__plein.engine
      const el = [...e.doc.elements()].find((el) => el.assetId === assetId)!
      return { id: el.id, rect: e.doc.worldRect(el.id) }
    }, assetId)
    const original = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), blocker)
    const a = imported.rect,
      b = original
    expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    expect(await page.evaluate((id) => !!window.__plein.engine.doc.get(id), imported.id)).toBe(
      false,
    )
    expect(await page.evaluate((id) => !!window.__plein.engine.doc.get(id), blocker)).toBe(true)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect
      .poll(() => page.evaluate((id) => !!window.__plein.engine.doc.get(id), imported.id))
      .toBe(true)
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
  },
)

test(
  '命名检查点预览只读且恢复新画布保留原版本，原画布继续保留修改',
  { tag: '@core' },
  async ({ page }, testInfo) => {
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
  },
)

test('素材缩略图失败仍可查看原图，刷新和原图重试可恢复预览', async ({ page }, testInfo) => {
  await newProject(page)
  const source = await image(page, '缩略图失败恢复专用')
  const assetId = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string,
    source.nodeId,
  )
  let thumbnailFailed = true
  let originalFailed = true
  await page.route(`**/api/assets/${assetId}/thumb-*`, (route) =>
    thumbnailFailed ? route.fulfill({ status: 503 }) : route.continue(),
  )
  await page.route(`**/api/assets/${assetId}`, (route) =>
    originalFailed ? route.fulfill({ status: 503 }) : route.continue(),
  )
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '素材', exact: true })
  await panel.getByRole('searchbox', { name: '搜索素材' }).fill('缩略图失败恢复专用')
  const card = panel.getByRole('button', { name: /查看素材 / }).first()
  await expect(card).toContainText('缩略图暂不可用')
  await card.click()
  const openPreview = panel.getByRole('button', { name: '放大查看素材' })
  await expect(openPreview).toContainText('缩略图暂不可用')
  await page.screenshot({
    path: testInfo.outputPath('thumbnail-failure.png'),
    animations: 'disabled',
  })
  await openPreview.click()
  const preview = page.getByRole('dialog', { name: '素材预览' })
  await expect(preview.getByRole('alert')).toContainText('素材加载失败')
  await page.screenshot({
    path: testInfo.outputPath('original-failure.png'),
    animations: 'disabled',
  })
  originalFailed = false
  await preview.getByRole('button', { name: '重试加载', exact: true }).click()
  await expect
    .poll(() => preview.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  thumbnailFailed = false
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await expect
    .poll(() => card.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await card.click()
  await openPreview.click()
  await expect
    .poll(() => preview.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
})

for (const kind of ['video', 'audio'] as const) {
  test(`${kind === 'video' ? '视频' : '音频'}原文件加载失败后可重试并实际播放`, async ({
    page,
  }, testInfo) => {
    await newProject(page)
    const video = kind === 'video'
    const media = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      video ? 'color=c=blue:s=96x64:d=2:r=10' : 'sine=f=440:d=2',
      ...(video
        ? ['-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']
        : ['-f', 'wav']),
      'pipe:1',
    ])
    const name = video ? '故障恢复视频.mp4' : '故障恢复音频.wav'
    const upload = await page.request.post('/api/assets', {
      headers: {
        'content-type': video ? 'video/mp4' : 'audio/wav',
        'x-file-name': encodeURIComponent(name),
      },
      data: media,
    })
    expect(upload.status()).toBe(201)
    const asset = (await upload.json()).id as string
    let failed = true
    await page.route(`**/api/assets/${asset}`, (route) =>
      failed ? route.fulfill({ status: 503 }) : route.continue(),
    )
    await page.getByRole('button', { name: '素材', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '素材', exact: true })
    await panel.getByRole('combobox', { name: '关联项目' }).click()
    await page.getByRole('option', { name: '全部项目', exact: true }).click()
    await panel.getByRole('searchbox', { name: '搜索素材' }).fill(name)
    await panel.getByRole('button', { name: `查看素材 ${name}`, exact: true }).click()
    if (video) await panel.getByRole('button', { name: '放大查看素材' }).click()
    const surface = video ? page.getByRole('dialog', { name: '素材预览' }) : panel
    await expect(surface.getByRole('alert')).toContainText(video ? '视频加载失败' : '音频加载失败')
    await page.screenshot({
      path: testInfo.outputPath(`${kind}-failure.png`),
      animations: 'disabled',
    })
    failed = false
    await surface.getByRole('button', { name: '重试加载', exact: true }).click()
    const player = surface.locator(kind)
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(1)
    await player.evaluate((el) => (el as HTMLMediaElement).play())
    await expect
      .poll(() => player.evaluate((el) => (el as HTMLMediaElement).currentTime))
      .toBeGreaterThan(0)
    expect(await player.evaluate((el) => (el as HTMLMediaElement).error)).toBeNull()
    await player.evaluate((el) => (el as HTMLMediaElement).pause())
  })
}
