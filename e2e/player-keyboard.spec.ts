import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { centerOf, newProject, zoomTo } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-player-keys-'))
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=320x180:d=20',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'clip.mp4'),
  ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=20',
    join(dir, 'clip.wav'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

for (const kind of ['video', 'audio'] as const) {
  test(`${kind} 播放器键盘操作尊重按钮焦点并可访问进度条`, async ({ page }) => {
    await newProject(page)
    const file = kind === 'video' ? 'clip.mp4' : 'clip.wav'
    const uploaded = await page.request.post('/api/assets', {
      headers: { 'content-type': kind === 'video' ? 'video/mp4' : 'audio/wav' },
      data: readFileSync(join(dir, file)),
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
              name: '键盘播放器',
              parentId: null,
              x: 0,
              y: 0,
              w: 640,
              h: kind === 'video' ? 360 : 100,
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
    await expect(player).toBeVisible()
    const media = player.locator(kind)
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.readyState))
      .toBeGreaterThanOrEqual(2)
    await player.evaluate((el) => el.focus())
    if (!(await media.evaluate((m: HTMLMediaElement) => m.paused))) await page.keyboard.press('k')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)

    const mute = player.getByRole('button', { name: /^(取消)?静音$/ })
    await mute.focus()
    await page.keyboard.press('Space')
    await expect(mute).toHaveAttribute('aria-label', '取消静音')
    expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
    await page.keyboard.press('Enter')
    await expect(mute).toHaveAttribute('aria-label', '静音')

    await player.getByRole('button', { name: '播放', exact: true }).focus()
    await page.keyboard.press('Tab')
    const track = player.getByRole('slider', { name: '播放进度' })
    await expect(track).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeCloseTo(5, 0)
    await page.keyboard.press('End')
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeCloseTo(20, 0)
    await page.keyboard.press('Home')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime)).toBe(0)
    await expect(track).toHaveAttribute('aria-valuemin', '0')
    await expect(track).toHaveAttribute('aria-valuemax', '100')
    await expect(track).toHaveAttribute('aria-valuetext', '0:00 / 0:20')
    await page.keyboard.press('ArrowLeft')
    expect(await media.evaluate((m: HTMLMediaElement) => m.currentTime)).toBe(0)
    await page.keyboard.press('ArrowUp')
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeCloseTo(5, 0)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime)).toBe(0)

    await player.evaluate((el) => el.focus())
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板' })
    await expect(palette).toBeVisible()
    expect(await media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await player.evaluate((el) => el.focus())
    expect(
      await player.evaluate((el) => {
        return [
          { key: 'm', metaKey: true },
          { key: 'ArrowRight', altKey: true },
          { key: 'k', isComposing: true },
          { key: 'k', keyCode: 229 },
        ].map((init) =>
          el.dispatchEvent(
            new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
          ),
        )
      }),
    ).toEqual([true, true, true, true])
    await player.evaluate((el) => {
      const target = el.firstElementChild!
      target.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }),
      )
    })
    expect(
      await media.evaluate((m: HTMLMediaElement) => ({
        paused: m.paused,
        muted: m.muted,
        time: m.currentTime,
      })),
    ).toEqual({ paused: true, muted: false, time: 0 })
    await page.keyboard.press('m')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.muted)).toBe(true)
    await page.keyboard.press('Space')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(false)
    await page.keyboard.down('k')
    await page.keyboard.down('k')
    await page.keyboard.up('k')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(true)
    await player.getByRole('button', { name: '播放', exact: true }).focus()
    await page.keyboard.press('Space')
    await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.paused)).toBe(false)
    await page.mouse.move(1, 1)
    // 跨过播放器的自动收起期限，验证键盘焦点仍可见。
    expect(
      await player.evaluate(
        (el) =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(el.classList.contains('is-idle')), 2300)
          }),
      ),
    ).toBe(false)
    await expect(player.locator('.plein-player-bar')).toHaveCSS('opacity', '1')
    await player.screenshot({ path: test.info().outputPath(`player-${kind}-focus.png`) })
    if (kind === 'video') {
      await player.getByRole('button', { name: '全屏', exact: true }).focus()
      await page.keyboard.press('Space')
      await expect(player).toHaveClass(/is-fullscreen/)
      await page.keyboard.press('Enter')
      await expect(player).not.toHaveClass(/is-fullscreen/)
    }
    await page.keyboard.press('Escape')
    await expect(player).toHaveCount(0)
    expect(
      await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((e) => e.id)),
    ).toEqual([id])
    expect(
      await page.evaluate(() => document.activeElement?.closest('[data-plein-active]') !== null),
    ).toBe(false)
  })
}
