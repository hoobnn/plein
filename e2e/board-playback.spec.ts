import { expect, test } from '@playwright/test'
import { newProject, waitNode } from './canvas'

for (const [kind, brokenWaveform] of [
  ['video', false],
  ['audio', false],
  ['audio', true],
] as const) {
  test(`故事板 ${kind} 可播放、失败重试并在关闭后停止${brokenWaveform ? '（波形不可用）' : ''}`, async ({
    page,
  }) => {
    await newProject(page)
    const name = `故事板-${kind}`
    const id = await page.evaluate(
      ({ kind, name }) =>
        window.__plein.addNode({
          type: kind === 'audio' ? 'plein/speech' : 'plein/video',
          name,
          params:
            kind === 'audio'
              ? { model: 'plein/mock:audio', text: '雨后的早晨，你好。' }
              : { model: 'plein/mock:video', mode: 'text', prompt: '雨后的水杯', count: 2 },
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
        results: window.__plein.engine.doc.get(id)!.results!,
        adopted: window.__plein.engine.doc.mutable(id)?.get('adopted'),
      }),
      id,
    )
    let failed = true
    if (brokenWaveform)
      await page.route(`**/api/assets/${before.results[0]!.value.assetId}/waveform`, (route) =>
        route.fulfill({ status: 503, body: 'temporary waveform failure' }),
      )
    await page.route(`**/api/assets/${before.results[0]!.value.assetId}`, (route) =>
      failed ? route.fulfill({ status: 503, body: 'temporary media failure' }) : route.continue(),
    )
    await page.getByRole('button', { name: '故事板', exact: true }).click()
    const column = page.getByRole('region', {
      name: kind === 'audio' ? '音频' : '视频',
      exact: true,
    })
    const card = column.getByRole('button', { name: `查看${name}`, exact: true })
    if (brokenWaveform) await expect(card).toContainText('缩略图加载失败')
    else await expect(card.locator('.board-play')).toBeVisible()
    await card.click()
    const viewer = page.getByRole('dialog', { name: `查看「${name}」`, exact: true })
    await expect(viewer).toBeVisible()
    await expect(viewer.getByRole('alert')).toHaveText(
      kind === 'audio' ? '音频加载失败' : '视频加载失败',
    )
    failed = false
    await viewer.getByRole('button', { name: '重新加载媒体', exact: true }).click()
    const media = viewer.locator(kind)
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(2)
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(0)
    if (kind === 'video') {
      await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
      await expect(viewer.getByText('候选 2 / 2', { exact: true })).toBeVisible()
      expect(
        await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), id),
      ).toBe(before.adopted)
    }
    const handle = await media.elementHandle()
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(viewer).toHaveCount(0)
    expect(
      await handle!.evaluate((el: HTMLMediaElement) => el.paused && !el.getAttribute('src')),
    ).toBe(true)
    await expect(column).toBeVisible()
    await expect(card).toBeFocused()
    await card.click()
    await expect(viewer.locator(kind)).toBeVisible()
    await expect
      .poll(() => viewer.locator(kind).evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(2)
    await expect(viewer).toHaveCSS('opacity', '1')
    if (kind === 'audio' && !brokenWaveform)
      await expect
        .poll(() =>
          viewer
            .locator('img')
            .evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
        )
        .toBe(true)
    if (brokenWaveform) await expect(viewer.locator('img')).toHaveCount(0)
    await viewer.screenshot({
      path: test.info().outputPath(`board-${kind}-playback.png`),
      animations: 'disabled',
    })
  })
}
