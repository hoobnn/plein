import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-player-seeking-'))
  for (const kind of ['video', 'audio'])
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      kind === 'video' ? 'color=c=orange:s=320x180:d=20' : 'sine=frequency=440:duration=20',
      ...(kind === 'video' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : []),
      join(dir, kind === 'video' ? 'clip.mp4' : 'clip.wav'),
    ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const kind of ['video'] as const) {
  const cancellations: Array<'lostcapture' | 'pendingcapture' | 'blur' | 'pointercancel'> = [
    'pointercancel',
  ]
  for (const cancellation of cancellations) {
    test(`${kind} 进度拖动越界及 ${cancellation} 中断后可继续操作 @core`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await newProject(page)
      const uploaded = await page.request.post('/api/assets', {
        headers: { 'content-type': kind === 'video' ? 'video/mp4' : 'audio/wav' },
        data: readFileSync(join(dir, kind === 'video' ? 'clip.mp4' : 'clip.wav')),
      })
      expect(uploaded.status()).toBe(201)
      const assetId = (await uploaded.json()).id as string
      const id = await page.evaluate(
        ({ kind, assetId }) => {
          const e = window.__plein.engine as unknown as {
            paste(data: unknown): void
            selection: { values(): string[]; set(ids: string[]): void }
          }
          e.paste({
            plein: 1,
            elements: [
              {
                id: 'media',
                kind,
                assetId,
                name: '进度拖动',
                parentId: null,
                x: 0,
                y: 0,
                w: kind === 'video' ? 640 : 384,
                h: kind === 'video' ? 360 : 96,
                rotation: 0,
                locked: false,
              },
            ],
            edges: [],
          })
          const id = e.selection.values()[0]!
          e.selection.set([])
          return id
        },
        { kind, assetId },
      )
      await zoomTo(page, [id])
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
      const player = page.locator('.plein-player')
      const media = player.locator(kind)
      await expect
        .poll(() => media.evaluate((m: HTMLMediaElement) => m.readyState))
        .toBeGreaterThanOrEqual(2)
      if (!(await media.evaluate((m: HTMLMediaElement) => m.paused))) await page.keyboard.press('k')
      const track = player.getByRole('slider', { name: '播放进度' })
      const r = (await track.boundingBox())!
      const y = r.y + r.height / 2
      const time = () => media.evaluate((m: HTMLMediaElement) => m.currentTime)
      await page.mouse.move(r.x + r.width / 2, y)
      await page.mouse.down()
      await page.mouse.move(r.x + r.width + 40, y)
      await expect.poll(time).toBeCloseTo(20, 0)
      await page.mouse.move(r.x - 40, y)
      await expect.poll(time).toBe(0)
      await page.mouse.up()
      await expect(player).not.toHaveClass(/is-scrubbing/)

      await page.mouse.move(r.x + r.width / 2, y)
      await page.mouse.down()
      await expect(player).toHaveClass(/is-scrubbing/)
      if (cancellation !== 'pendingcapture') await page.mouse.move(r.x + r.width * 0.55, y)
      const ownTime = await time()
      await track.evaluate((el) => {
        for (const type of [
          'pointerdown',
          'pointermove',
          'pointerup',
          'pointercancel',
          'lostpointercapture',
        ])
          el.dispatchEvent(
            new PointerEvent(type, { pointerId: 2, button: 0, clientX: 1, bubbles: true }),
          )
      })
      expect(await time()).toBeCloseTo(ownTime, 2)
      await expect(player).toHaveClass(/is-scrubbing/)
      await track.evaluate((el, cancellation) => {
        if (cancellation === 'blur') window.dispatchEvent(new Event('blur'))
        else if (cancellation === 'lostcapture' || cancellation === 'pendingcapture')
          el.releasePointerCapture(1)
        else el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }))
      }, cancellation)
      // 浏览器在后续指针事件之前处理显式释放产生的 lostpointercapture。
      await page.mouse.move(r.x + r.width * 0.6, y)
      await expect(player).not.toHaveClass(/is-scrubbing/)
      expect(await track.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
      const stopped = await time()
      await page.mouse.move(r.x + r.width * 0.8, y)
      expect(await time()).toBeCloseTo(stopped, 2)
      await page.mouse.up()
      await page.mouse.click(r.x + r.width * 0.25, y)
      await expect.poll(time).toBeCloseTo(5, 0)
      await expect(track).toBeFocused()
      await expect(player).not.toHaveClass(/is-scrubbing/)
      await page.keyboard.press('ArrowRight')
      await expect.poll(time).toBeCloseTo(10, 0)
      expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
      const geometry = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
      await page.mouse.move(r.x + r.width / 2, y)
      await page.mouse.down()
      const retiredTrack = (await track.elementHandle())!
      const retiredMedia = (await media.elementHandle())!
      await page.keyboard.press('Escape')
      await expect(player).toHaveCount(0)
      expect(await retiredTrack.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
      expect(
        await retiredMedia.evaluate((m: HTMLMediaElement) => ({
          paused: m.paused,
          src: m.getAttribute('src'),
        })),
      ).toEqual({ paused: true, src: null })
      await page.mouse.move(r.x + r.width * 0.8, y)
      await page.mouse.up()
      expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
        geometry,
      )
      await Promise.all([retiredTrack.dispose(), retiredMedia.dispose()])
      expect(errors).toEqual([])
      expect(
        await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((e) => e.id)),
      ).toEqual([id])
    })
  }
}
