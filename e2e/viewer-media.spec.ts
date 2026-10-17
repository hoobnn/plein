import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { newProject, zoomTo } from './canvas'

for (const kind of ['audio', 'video'] as const) {
  test(`候选${kind}失败可恢复，切换和关闭停止旧播放且不改变采用`, async ({ page }) => {
    await newProject(page)
    const assets: string[] = []
    for (const index of [0, 1]) {
      const data = execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        kind === 'audio'
          ? `sine=f=${440 + index * 220}:d=8`
          : `color=c=${index ? 'green' : 'blue'}:s=96x64:d=8:r=10`,
        ...(kind === 'audio'
          ? ['-f', 'wav']
          : ['-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']),
        'pipe:1',
      ])
      const response = await page.request.post('/api/assets', {
        headers: {
          'content-type': kind === 'audio' ? 'audio/wav' : 'video/mp4',
          'x-file-name': `review-${kind}-${index}.${kind === 'audio' ? 'wav' : 'mp4'}`,
        },
        data,
      })
      expect(response.status()).toBe(201)
      assets.push(((await response.json()) as { id: string }).id)
    }
    const target = await page.evaluate(
      ({ kind, assets }) => {
        const id = window.__plein.addNode({
          type: kind === 'audio' ? 'plein/speech' : 'plein/video',
          name: `恢复${kind}候选`,
          params: {},
          x: 400,
          y: 300,
        })
        const mutable = window.__plein.engine.doc.mutable(id) as unknown as {
          set(key: string, value: unknown): void
        }
        mutable.set(
          'results',
          assets.map((assetId, index) => ({
            id: `candidate-${index}`,
            runId: 'fixture-run',
            port: kind,
            value: { type: kind, assetId },
            at: index + 1,
          })),
        )
        mutable.set('adopted', 'candidate-0')
        return id
      },
      { kind, assets },
    )
    let fail = true
    await page.route(`**/api/assets/${assets[0]}`, (route) =>
      fail ? route.fulfill({ status: 503 }) : route.continue(),
    )
    const next = page.getByRole('button', { name: '下一个结果', exact: true })
    await expect(next).toBeVisible()
    await zoomTo(page, [target])
    await next.click()
    const viewer = page.getByRole('dialog', { name: `查看「恢复${kind}候选」`, exact: true })
    await viewer.getByRole('button', { name: '预览上一个候选', exact: true }).click()
    await expect(viewer.getByRole('alert')).toContainText(
      kind === 'audio' ? '音频加载失败' : '视频加载失败',
    )
    const retry = viewer.getByRole('button', { name: '重新加载媒体', exact: true })
    await retry.focus()
    await retry.press('Enter')
    await expect(retry).toBeVisible()
    await viewer.screenshot({
      path: test.info().outputPath(`${kind}-failure.png`),
      animations: 'disabled',
    })
    await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    const player = viewer.locator(kind)
    await expect
      .poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(1)
    await player.evaluate((el: HTMLMediaElement) => el.play())
    await expect
      .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(0)
    const previous = await player.elementHandle()
    await viewer.getByRole('button', { name: '预览上一个候选', exact: true }).click()
    await expect(viewer.getByRole('alert')).toBeVisible()
    await expect
      .poll(() =>
        previous!.evaluate((el: HTMLMediaElement) => el.paused && !el.getAttribute('src')),
      )
      .toBe(true)
    fail = false
    await retry.click()
    await expect
      .poll(() => player.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(1)
    await player.evaluate((el: HTMLMediaElement) => el.play())
    await expect
      .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(0)
    await expect(player).toHaveAttribute('src', new RegExp(assets[0]!))
    expect(
      await page.evaluate((id) => window.__plein.engine.doc.mutable(id)?.get('adopted'), target),
    ).toBe('candidate-0')
    const closing = await player.elementHandle()
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(viewer).toHaveCount(0)
    await expect
      .poll(() => closing!.evaluate((el: HTMLMediaElement) => el.paused && !el.getAttribute('src')))
      .toBe(true)
    await previous!.dispose()
    await closing!.dispose()
  })
}
