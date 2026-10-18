import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { centerOf, newProject, waitEngine, zoomTo } from './canvas'

test('另一端采用或移除视频候选时，内联播放器切到正确素材并停止旧媒体', async ({
  page,
  browser,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'plein-player-candidates-'))
  const peerContext = await browser.newContext()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await newProject(page)
    const assets: string[] = []
    for (const color of ['orange', 'teal']) {
      const path = join(dir, `${color}.mp4`)
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=320x180:d=20`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        path,
      ])
      const uploaded = await page.request.post('/api/assets', {
        headers: { 'content-type': 'video/mp4' },
        data: readFileSync(path),
      })
      expect(uploaded.status()).toBe(201)
      assets.push((await uploaded.json()).id as string)
    }
    expect(assets[0]).not.toBe(assets[1])
    const id = await page.evaluate((assets) => {
      const id = window.__plein.addNode({
        type: 'plein/video',
        name: '协作切换视频',
        params: {},
        x: 0,
        y: 0,
      })
      const m = window.__plein.engine.doc.mutable(id) as unknown as {
        set(k: string, v: unknown): void
      }
      m.set(
        'results',
        assets.map((assetId, i) => ({
          id: `candidate-${i}`,
          runId: `run-${i}`,
          port: 'video',
          value: { type: 'video', assetId },
          at: 2 - i,
        })),
      )
      m.set('adopted', 'candidate-0')
      window.__plein.engine.selection.set([])
      return id
    }, assets)
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const player = page.locator('.plein-player')
    const media = player.locator('video')
    await expect(media).toHaveAttribute('src', `/api/assets/${assets[0]}`)
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeGreaterThan(0)
    const first = (await media.elementHandle())!

    const peer = await peerContext.newPage()
    await peer.goto(page.url())
    await waitEngine(peer)
    await expect
      .poll(() => peer.evaluate((id) => window.__plein.engine.doc.get(id)?.results?.length, id))
      .toBe(2)
    await peer.getByRole('treeitem', { name: '协作切换视频 定位到画布', exact: true }).click()
    await peer
      .getByTestId('generator')
      .getByRole('button', { name: '全屏查看', exact: true })
      .click()
    const viewer = peer.getByRole('dialog', { name: '查看「协作切换视频」', exact: true })
    await viewer.getByRole('button', { name: '预览下一个候选', exact: true }).click()
    await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
    await expect(media).toHaveAttribute('src', `/api/assets/${assets[1]}`)
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeGreaterThan(0)
    expect(
      await first.evaluate((m: HTMLMediaElement) => ({
        paused: m.paused,
        src: m.getAttribute('src'),
      })),
    ).toEqual({ paused: true, src: null })
    const second = (await media.elementHandle())!
    await viewer.getByRole('button', { name: '预览上一个候选', exact: true }).click()
    await viewer.getByRole('button', { name: '采用此候选', exact: true }).click()
    await expect(media).toHaveAttribute('src', `/api/assets/${assets[0]}`)
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeGreaterThan(0)
    expect(
      await second.evaluate((m: HTMLMediaElement) => ({
        paused: m.paused,
        src: m.getAttribute('src'),
      })),
    ).toEqual({ paused: true, src: null })
    await peer.evaluate((id) => {
      const m = window.__plein.engine.doc.mutable(id) as unknown as {
        get(k: string): unknown
        set(k: string, v: unknown): void
      }
      m.set(
        'results',
        (m.get('results') as { id: string }[]).filter((r) => r.id !== 'candidate-0'),
      )
      m.set('adopted', undefined)
    }, id)
    await expect(media).toHaveAttribute('src', `/api/assets/${assets[1]}`)
    await expect
      .poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime))
      .toBeGreaterThan(0)
    const last = (await media.elementHandle())!
    await peer.evaluate((id) => {
      ;(
        window.__plein.engine.doc.mutable(id) as unknown as { set(k: string, v: unknown): void }
      ).set('results', [])
    }, id)
    await expect(player).toHaveCount(0)
    expect(
      await last.evaluate((m: HTMLMediaElement) => ({
        paused: m.paused,
        src: m.getAttribute('src'),
      })),
    ).toEqual({ paused: true, src: null })
    expect(
      await page.evaluate(() => [...window.__plein.engine.doc.elements()].map((e) => e.id)),
    ).toEqual([id])
    expect(errors).toEqual([])
    await Promise.all([first.dispose(), second.dispose(), last.dispose()])
  } finally {
    await peerContext.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
