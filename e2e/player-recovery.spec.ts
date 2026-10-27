import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-player-recovery-'))
  for (const kind of ['video', 'audio']) {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      kind === 'video' ? 'color=c=teal:s=320x180:d=12' : 'sine=frequency=440:duration=12',
      ...(kind === 'video' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : []),
      join(dir, kind === 'video' ? 'clip.mp4' : 'clip.wav'),
    ])
  }
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const kind of ['video', 'audio'] as const) {
  test(`${kind} 加载中暂停不误报失败，失败重载及退出后迟到响应可恢复`, async ({ page }) => {
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
              name: '加载恢复播放器',
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
    let mode: 'hold' | 'fail' | 'pass' = 'hold'
    let release = () => {}
    let gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let requests = 0
    await page.route(`**/api/assets/${assetId}`, async (route) => {
      requests++
      if (mode === 'hold') await gate
      if (mode === 'fail') await route.fulfill({ status: 503, body: 'fixture offline' })
      else await route.continue()
    })
    const open = async () => {
      await zoomTo(page, [id])
      const at = await centerOf(page, id)
      await page.mouse.dblclick(at.x, at.y)
      await expect(page.locator('.plein-player')).toBeVisible()
    }
    const player = page.locator('.plein-player')
    const media = player.locator(kind)
    const retry = player.getByRole('button', { name: '重新加载', exact: true })
    try {
      await open()
      await expect.poll(() => requests).toBeGreaterThan(0)
      await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(false)
      await page.keyboard.press('k')
      await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
      await page.keyboard.press('k')
      await page.keyboard.press('k')
      await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
      mode = 'pass'
      release()
      await expect
        .poll(() => media.evaluate((m: HTMLMediaElement) => m.readyState))
        .toBeGreaterThanOrEqual(2)
      await expect(retry).not.toBeVisible()
      expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
      await expect(player.getByRole('status')).not.toBeVisible()
      if (kind === 'video') {
        await expect(media).toHaveCSS('opacity', '1')
        await expect(player.locator('img')).toBeHidden()
      }
      await player.screenshot({ path: test.info().outputPath(`player-${kind}-paused-ready.png`) })
      await page.keyboard.press('k')
      await expect
        .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
        .toBeGreaterThan(0)
      await expect(player.getByRole('status')).not.toBeVisible()
      await page.keyboard.press('Escape')
      await expect(player).toHaveCount(0)

      mode = 'fail'
      await open()
      await expect(retry).toBeVisible()
      await expect(player.getByRole('status')).toContainText('原文件仍')
      const layout = await player.evaluate((el) => {
        const outer = el.getBoundingClientRect()
        const message = el.querySelector('[role="status"] span')!.getBoundingClientRect()
        const retry = el.querySelector('[role="status"] button')!.getBoundingClientRect()
        const bar = el.querySelector('.plein-player-bar')!.getBoundingClientRect()
        return {
          contained:
            message.top >= outer.top &&
            message.bottom <= outer.bottom &&
            retry.top >= outer.top &&
            retry.bottom <= outer.bottom,
          separated: retry.bottom <= bar.top,
        }
      })
      expect(layout.contained).toBe(true)
      if (kind === 'audio') expect(layout.separated).toBe(true)
      await player.screenshot({ path: test.info().outputPath(`player-${kind}-failure.png`) })
      const failedRequests = requests
      await retry.click({ timeout: 1500 })
      await expect.poll(() => requests).toBeGreaterThan(failedRequests)
      await expect(retry).toBeVisible()
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await player.screenshot({ path: test.info().outputPath(`player-${kind}-failure-dark.png`) })
      const darkRequests = requests
      await retry.focus()
      await page.keyboard.press('Space')
      await expect.poll(() => requests).toBeGreaterThan(darkRequests)
      await expect(retry).toBeVisible()
      mode = 'pass'
      await retry.focus()
      await page.keyboard.press('Enter')
      await expect
        .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
        .toBeGreaterThan(0)
      await expect(player.getByRole('status')).not.toBeVisible()
      await page.keyboard.press('Escape')
      await expect(player).toHaveCount(0)

      mode = 'hold'
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const before = requests
      await open()
      await expect.poll(() => requests).toBeGreaterThan(before)
      const retired = (await media.elementHandle())!
      await page.keyboard.press('Escape')
      await expect(player).toHaveCount(0)
      expect(
        await retired.evaluate((m: HTMLMediaElement) => ({
          paused: m.paused,
          src: m.getAttribute('src'),
        })),
      ).toEqual({ paused: true, src: null })
      mode = 'pass'
      release()
      await open()
      await expect
        .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
        .toBeGreaterThan(0)
      await expect(retry).not.toBeVisible()
      expect(
        await retired.evaluate((m: HTMLMediaElement) => ({
          paused: m.paused,
          src: m.getAttribute('src'),
        })),
      ).toEqual({ paused: true, src: null })
      await retired.dispose()
      expect(
        await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((e) => e.id)),
      ).toEqual([id])
    } finally {
      release()
    }
  })
}
