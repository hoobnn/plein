import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures'
import { clickElement, newProject } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
for (const kind of ['video', 'audio'] as const) {
  test(`同素材 ${kind} 切换媒体类型后释放旧播放器，新播放器可继续播放`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await newProject(page)
    const bytes = execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x96:d=8:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=8',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ])
    const response = await page.request.post('/api/assets', {
      headers: { 'content-type': 'video/mp4', 'x-file-name': 'dual-media.mp4' },
      data: bytes,
    })
    expect(response.status()).toBe(201)
    const assetId = ((await response.json()) as { id: string }).id
    const id = await page.evaluate(
      ({ kind, assetId }) => {
        const id = window.__plein.addNode({
          type: 'plein/video',
          name: '相同素材切换类型',
          params: {},
          x: 500,
          y: 300,
        })
        const engine = window.__plein.engine as unknown as Engine
        engine.doc.mutable(id)!.set('results', [
          {
            id: 'shared-media',
            runId: 'fixture',
            port: 'video',
            value: { type: kind, assetId },
            at: 1,
          },
        ])
        engine.doc.mutable(id)!.set('adopted', 'shared-media')
        engine.doc.flush()
        return id
      },
      { kind, assetId },
    )
    await clickElement(page, id)
    await page.getByRole('button', { name: '全屏查看', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '查看「相同素材切换类型」', exact: true })
    const original = viewer.locator(kind)
    await expect
      .poll(() => original.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(1)
    await original.evaluate((el: HTMLMediaElement) => el.play())
    await expect
      .poll(() => original.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(0)
    const old = await original.elementHandle()
    const nextKind = kind === 'video' ? 'audio' : 'video'
    await page.evaluate(
      ({ id, nextKind }) => {
        const engine = window.__plein.engine as unknown as Engine
        const results = engine.doc
          .get(id)!
          .results!.map((r) => ({ ...r, value: { ...r.value, type: nextKind } }))
        engine.doc.mutable(id)!.set('results', results)
        engine.doc.flush()
      },
      { id, nextKind },
    )
    const current = viewer.locator(nextKind)
    await expect(current).toHaveAttribute('src', `/api/assets/${assetId}`)
    await expect
      .poll(() =>
        old!.evaluate((el: HTMLMediaElement) => ({
          paused: el.paused,
          src: el.getAttribute('src'),
        })),
      )
      .toEqual({ paused: true, src: null })
    await expect
      .poll(() => current.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(1)
    await current.evaluate((el: HTMLMediaElement) => el.play())
    await expect
      .poll(() => current.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(0)
    const active = await current.elementHandle()
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect
      .poll(() => active!.evaluate((el: HTMLMediaElement) => el.paused && !el.getAttribute('src')))
      .toBe(true)
    expect(
      await page.evaluate(
        (id) => (window.__plein.engine as unknown as Engine).doc.get(id)!.adopted,
        id,
      ),
    ).toBe('shared-media')
    expect(errors).toEqual([])
    await old!.dispose()
    await active!.dispose()
  })
}
