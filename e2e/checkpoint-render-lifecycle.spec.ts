import { expect, test } from './fixtures'
import { newProject, waitNode } from './canvas'
import { article, checkpointPair, openCheckpoints, panel } from './checkpoints'

test.use({ hasTouch: true })

test('只读检查点真实拖动、触屏缩放、窄屏适应和恢复不改变原画布 @core', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await checkpointPair(page)
  const originalId = decodeURIComponent(page.url().split('#/c/')[1]!)
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const [checkpoint, text] of [
      [f.first, '第一版正文'],
      [f.second, '第二版正文'],
    ] as const) {
      await article(page, checkpoint.name)
        .getByRole('button', { name: '只读预览', exact: true })
        .click()
      await expect(panel(page).getByTestId('checkpoint-preview')).toContainText(text)
      await expect(panel(page).getByRole('button', { name: '适应画布', exact: true })).toBeEnabled()
    }
    if (!cycle) {
      await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
      await openCheckpoints(page)
    }
  }
  const preview = panel(page).getByTestId('checkpoint-preview')
  const label = preview.getByText('预览原稿 第二版正文', { exact: true })
  for (const fromCard of [true, false]) {
    const before = (await label.boundingBox())!
    const canvas = (await preview.locator('canvas').boundingBox())!
    const start = fromCard
      ? { x: before.x + before.width / 2, y: before.y + before.height / 2 + 40 }
      : { x: canvas.x + 80, y: canvas.y + 80 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 40, start.y + 20, { steps: 3 })
    await expect
      .poll(async () => Math.abs((await label.boundingBox())!.x - before.x - 40))
      .toBeLessThan(2)
    await page.mouse.up()
    await preview.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect
      .poll(async () => Math.abs((await label.boundingBox())!.x - before.x))
      .toBeLessThan(1)
  }
  await page.setViewportSize({ width: 320, height: 700 })
  await expect
    .poll(() =>
      label.evaluate(async (el) => {
        const surface = el.closest('[data-testid="checkpoint-preview"]')!.querySelector('canvas')!,
          host = surface.parentElement!,
          geometry = () => [el.getBoundingClientRect(), surface.getBoundingClientRect()],
          previous = JSON.stringify(geometry())
        // viewport 命令先于 ResizeObserver 完成；等渲染尺寸和取景跨帧稳定后再取触点。
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const rect = el.getBoundingClientRect(),
          canvas = surface.getBoundingClientRect()
        return {
          viewport: innerWidth,
          canvasInViewport: canvas.left >= 0 && canvas.right <= innerWidth,
          rendererSized:
            Math.abs(surface.width / devicePixelRatio - host.clientWidth) < 1 &&
            Math.abs(surface.height / devicePixelRatio - host.clientHeight) < 1,
          stable: previous === JSON.stringify(geometry()),
          fitted:
            rect.left >= canvas.left &&
            rect.right <= canvas.right &&
            rect.top >= canvas.top &&
            rect.bottom <= canvas.bottom,
        }
      }),
    )
    .toEqual({
      viewport: 320,
      canvasInViewport: true,
      rendererSized: true,
      stable: true,
      fitted: true,
    })
  const canvas = (await preview.locator('canvas').boundingBox())!
  const cx = canvas.x + canvas.width / 2,
    cy = canvas.y + canvas.height / 2
  const before = (await label.boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { id: 1, x: cx - 25, y: cy },
        { id: 2, x: cx + 25, y: cy },
      ],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { id: 1, x: cx - 40, y: cy },
        { id: 2, x: cx + 40, y: cy },
      ],
    })
    await expect
      .poll(async () => (await label.boundingBox())!.width / before.width)
      .toBeCloseTo(1.6, 1)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [{ id: 2, x: cx + 40, y: cy }],
    })
    const zoomed = (await label.boundingBox())!
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 1, x: cx - 20, y: cy + 10 }],
    })
    await expect
      .poll(async () => Math.abs((await label.boundingBox())!.x - zoomed.x - 20))
      .toBeLessThan(2)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
  await preview.getByRole('button', { name: '适应画布', exact: true }).click()
  await preview.locator('canvas').click()
  await page.keyboard.press('Delete')
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  await page.setViewportSize({ width: 1440, height: 900 })
  await article(page, f.first.name)
    .getByRole('button', { name: '恢复为新画布', exact: true })
    .click()
  await expect(page).not.toHaveURL(new RegExp(originalId))
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(window.__plein?.engine.doc.elements() ?? [])].some(
          (node) => node.params?.text === '第一版正文',
        ),
      ),
    )
    .toBe(true)
  expect((await page.request.get(`/api/canvases/${originalId}`)).status()).toBe(200)
  expect(errors).toEqual([])
})

test('图片检查点切换关闭和恢复不销毁仍在使用的纹理 @core', async ({ page }) => {
  const media = true
  const warnings: string[] = [],
    errors: string[] = []
  page.on('console', (message) => {
    if (
      message.type() === 'warning' &&
      /BindGroup|destroyed while still bound/.test(message.text())
    )
      warnings.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  const nodeId = await page.evaluate(
    (media) =>
      window.__plein.addNode({
        type: media ? 'plein/image' : 'plein/text',
        name: '纹理生命周期原稿',
        x: 0,
        y: 0,
        params: media
          ? { prompt: '海边的白色海鸟', model: 'plein/mock:image' }
          : { text: '纹理生命周期正文' },
      }),
    media,
  )
  const originalId = decodeURIComponent(page.url().split('#/c/')[1]!)
  if (media) {
    await expect
      .poll(async () =>
        (
          await page.request.post(`/api/canvases/${originalId}/nodes/${nodeId}/run`, { data: {} })
        ).status(),
      )
      .toBe(202)
    await waitNode(page, nodeId)
  }
  await page.getByRole('button', { name: '检查点', exact: true }).click()
  for (const name of ['资源第一版', '资源第二版']) {
    if (name === '资源第二版')
      await page.evaluate((id) => {
        ;(
          window.__plein.engine.doc.mutable(id)!.get('params') as {
            set(key: string, value: string): void
          }
        ).set('description', '第二版的设定变更')
      }, nodeId)
    await panel(page).getByRole('textbox', { name: '检查点名称', exact: true }).fill(name)
    await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
    await expect(article(page, name)).toBeVisible()
    await expect(
      panel(page)
        .getByTestId('checkpoint-preview')
        .getByRole('button', { name: '适应画布', exact: true }),
    ).toBeEnabled()
  }
  const original = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  for (let i = 0; i < 1; i++) {
    for (const name of ['资源第一版', '资源第二版']) {
      await article(page, name).getByRole('button', { name: '只读预览', exact: true }).click()
      await expect(
        panel(page)
          .getByTestId('checkpoint-preview')
          .getByRole('button', { name: '适应画布', exact: true }),
      ).toBeEnabled()
    }
    await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
    await expect(panel(page)).toHaveCount(0)
    await page.evaluate(() => window.__plein.engine.zoomToFit())
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(original)
    await page.getByRole('button', { name: '检查点', exact: true }).click()
  }
  await article(page, '资源第一版')
    .getByRole('button', { name: '恢复为新画布', exact: true })
    .click()
  await expect(page).not.toHaveURL(new RegExp(originalId))
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(window.__plein?.engine.doc.elements() ?? [])].some(
          (node) => node.name === '纹理生命周期原稿',
        ),
      ),
    )
    .toBe(true)
  await page.evaluate(() => window.__plein.engine.zoomToFit())
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  if (media) {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { stats } = window.__plein.engine as Window['__plein']['engine'] & {
            stats: {
              previews: { ready: number }
              previewRevision: number
              renderedPreviewRevision: number
            }
          }
          return stats.previews.ready > 0 && stats.previewRevision === stats.renderedPreviewRevision
        }),
      )
      .toBe(true)
    await page.screenshot({
      path: test.info().outputPath('restored-texture.png'),
      animations: 'disabled',
    })
  }
  expect(errors).toEqual([])
  expect(warnings.slice(0, 1)).toEqual([])
})
