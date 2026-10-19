import { expect, test } from '@playwright/test'
import { newProject, waitNode } from './canvas'

for (const kind of ['image', 'video', 'audio'] as const) {
  test(`故事板 ${kind} 缩略图失败可重试，不改变采用或误开预览`, async ({ page }) => {
    await newProject(page)
    const name = `缩略图恢复-${kind}`
    const id = await page.evaluate(
      ({ kind, name }) =>
        window.__plein.addNode({
          type: kind === 'audio' ? 'plein/speech' : `plein/${kind}`,
          name,
          params:
            kind === 'audio'
              ? { model: 'plein/mock:audio', text: '你好，雨后的早晨。' }
              : { model: `plein/mock:${kind}`, prompt: '雨后的水杯', mode: 'text', count: 2 },
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
    const before = await page.evaluate(
      (id) => ({
        result: window.__plein.engine.doc.get(id)!.results![0]!,
        next: window.__plein.engine.doc.get(id)!.results![1],
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
        rect: window.__plein.engine.doc.worldRect(id),
      }),
      id,
    )
    const variant = kind === 'image' ? 'thumb-1024' : kind === 'video' ? 'poster' : 'waveform'
    let failed = true
    let requests = 0
    await page.route(`**/api/assets/${before.result.value.assetId}/${variant}`, (route) => {
      requests++
      return failed
        ? route.fulfill({ status: 503, body: 'temporary thumbnail failure' })
        : route.continue()
    })
    if (kind === 'audio') await page.setViewportSize({ width: 390, height: 640 })
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    const preview = page.getByRole('button', { name: `查看${name}`, exact: true })
    const card = preview.locator('..')
    const retry = card.getByRole('button', { name: `重新加载「${name}」缩略图`, exact: true })
    await expect(retry).toBeVisible({ timeout: 2000 })
    await expect(preview).toContainText('缩略图加载失败')
    await page.screenshot({
      path: test.info().outputPath('board-thumbnail-failed.png'),
      animations: 'disabled',
    })
    await retry.click()
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2)
    await expect(retry).toBeVisible()
    failed = false
    await retry.focus()
    await retry.press('Enter')
    await expect
      .poll(() =>
        preview
          .locator('img')
          .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      )
      .toBe(true)
    await expect(retry).toHaveCount(0)
    await expect(preview).toBeFocused()
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
    ).toBe(before.adopted)
    expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
      before.rect,
    )
    const viewer = page.getByRole('dialog', { name: `查看「${name}」`, exact: true })
    await expect(viewer).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('board-thumbnail-recovered.png'),
      animations: 'disabled',
    })
    if (kind === 'image') {
      await preview.locator('img').evaluate(
        (image, { id, resultId }) => {
          const node = window.__plein.engine.doc.mutable(id) as unknown as {
            set(key: string, value: unknown): void
          }
          node.set('adopted', resultId)
          image.dispatchEvent(new Event('error'))
        },
        { id, resultId: before.next!.id },
      )
      await expect(preview.locator('img')).toHaveAttribute(
        'src',
        `/api/assets/${before.next!.value.assetId}/thumb-1024`,
      )
      await expect
        .poll(() =>
          preview
            .locator('img')
            .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
        )
        .toBe(true)
      await expect(retry).toHaveCount(0)
    }
    await preview.click()
    await expect(viewer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(preview).toBeFocused()
  })
}
