import { expect, test } from './fixtures'
import { newProject, waitNode } from './canvas'

for (const mode of ['image', 'video', 'audio', 'resize'] as const) {
  test(`历史缩略图 ${mode} 失败可恢复，重试不改变选择或采用`, async ({ page }) => {
    await newProject(page)
    const kind = mode === 'resize' ? 'image' : mode
    const name = `历史缩略图-${mode}`
    const id = await page.evaluate(
      ({ kind, name }) =>
        window.__plein.addNode({
          type: kind === 'audio' ? 'plein/speech' : `plein/${kind}`,
          name,
          params:
            kind === 'audio'
              ? { model: 'plein/mock:audio', text: '你好' }
              : { model: `plein/mock:${kind}`, prompt: '雨后的透明水杯' },
          x: 400,
          y: 300,
        }),
      { kind, name },
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
    const original = await page.evaluate(
      (id) => ({
        result: window.__plein.engine.doc.get(id)!.results![0]!.value.assetId as string,
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
      }),
      id,
    )
    let fail = true
    let requests = 0
    const variant = kind === 'video' ? 'poster' : kind === 'audio' ? 'waveform' : 'thumb-256'
    await page.route(`**/api/assets/${original.result}/${variant}`, (route) => {
      requests++
      return fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()
    })
    if (mode === 'audio') await page.setViewportSize({ width: 390, height: 640 })
    await page.getByRole('button', { name: '生成历史', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '生成历史', exact: true })
    const card = panel.getByRole('listitem').first()
    const retry = card.getByRole('button', { name: `重新加载「${name}」缩略图`, exact: true })
    if (mode === 'resize') await expect(card.locator('img')).toHaveCount(0)
    else await expect(retry).toBeVisible({ timeout: 1500 })
    await panel.screenshot({
      path: test.info().outputPath('history-thumbnail-failed.png'),
      animations: 'disabled',
    })
    await card.getByRole('checkbox').check()
    if (mode === 'resize') {
      const size = panel.getByRole('slider', { name: '缩略图大小', exact: true })
      await size.focus()
      await size.press('End')
    } else {
      await retry.click()
      await expect.poll(() => requests).toBeGreaterThanOrEqual(2)
      await expect(retry).toBeVisible()
      fail = false
      await retry.click()
    }
    await expect
      .poll(() =>
        card
          .locator('img')
          .evaluateAll((images) =>
            images.some(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true)
    await expect(card.getByRole('checkbox')).toBeChecked()
    if (mode === 'resize')
      await expect(panel.getByRole('slider', { name: '缩略图大小', exact: true })).toBeFocused()
    else
      await expect(card.getByRole('button', { name: `选择「${name}」`, exact: true })).toBeFocused()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
    ).toEqual(original.adopted)
    await expect(page.getByRole('dialog', { name: `查看「${name}」`, exact: true })).toHaveCount(0)
    await panel.screenshot({
      path: test.info().outputPath('history-thumbnail-recovered.png'),
      animations: 'disabled',
    })
    await card.getByRole('checkbox').uncheck()
    await card.getByRole('button', { name: `预览「${name}」`, exact: true }).click()
    const viewer = page.getByRole('dialog', { name: `查看「${name}」`, exact: true })
    await expect(viewer).toBeVisible()
    if (kind === 'image') {
      await expect
        .poll(() =>
          viewer
            .locator(`img[src="/api/assets/${original.result}"]`)
            .evaluateAll((images) =>
              images.some(
                (image) =>
                  image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
              ),
            ),
        )
        .toBe(true)
    } else {
      const media = viewer.locator(kind)
      await expect(media).toHaveAttribute('src', `/api/assets/${original.result}`)
      await media.evaluate(async (media: HTMLMediaElement) => {
        await media.play()
      })
      await expect
        .poll(() => media.evaluate((media: HTMLMediaElement) => media.currentTime))
        .toBeGreaterThan(0)
    }
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(panel).toBeVisible()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
    ).toEqual(original.adopted)
  })
}
