import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'

async function fixture(page: Page, type: string) {
  const data = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x90:d=30:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=30',
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
    headers: { 'content-type': 'video/mp4', 'x-file-name': 'activation-with-sound.mp4' },
    data,
  })
  expect(response.status()).toBe(201)
  const asset = (await response.json()) as { id: string }
  const id = await page.evaluate(
    (type) =>
      window.__plein.addNode({
        type,
        name: '激活回归',
        params: {},
        x: 400,
        y: 300,
      }),
    type,
  )
  await zoomTo(page, [id])
  return { id, assetId: asset.id }
}

async function result(page: Page, id: string, assetId: string, kind = 'video') {
  await page.evaluate(
    ({ id, assetId, kind }) => {
      const mutable = window.__plein.engine.doc.mutable(id) as unknown as {
        set(key: string, value: unknown): void
      }
      mutable.set('results', [
        {
          id: 'fixture-result',
          runId: 'fixture-run',
          port: kind,
          value: { type: kind, assetId },
          at: 1,
        },
      ])
    },
    { id, assetId, kind },
  )
}

for (const [type, hint, play] of [
  ['plein/sequence', '双击编辑序列', '播放成片'],
  ['plein/animatic', '双击编辑节奏样片', '播放样片'],
]) {
  test(`${type} 生成前后双击仅编辑，独立播放不编辑，进入编辑释放有声媒体`, async ({ page }) => {
    await newProject(page)
    const { id, assetId } = await fixture(page, type!)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    const players = page.locator('[data-player-el]')
    const open = async () => {
      const point = await centerOf(page, id)
      await page.mouse.dblclick(point.x, point.y)
      await expect(editor).toBeVisible()
      await expect(players).toHaveCount(0)
    }
    await expect(page.locator('.plein-node').getByText(hint!, { exact: true })).toBeVisible()
    await open()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await result(page, id, assetId)
    await expect(page.getByRole('button', { name: play!, exact: true })).toBeVisible()
    await expect(page.locator('.plein-node').getByText('双击播放', { exact: true })).toHaveCount(0)
    await open()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)

    for (const action of ['click', 'dblclick'] as const) {
      const before = await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)
      await page.getByRole('button', { name: play!, exact: true })[action]()
      await expect(players).toHaveCount(1)
      await expect(editor).toHaveCount(0)
      const video = players.locator('video')
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0))
        .toBe(true)
      expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false)
      const media = await video.elementHandle()
      // 键盘进入 Generator 编辑按钮，避免画布 pointerdown 提前关闭播放器掩盖生命周期问题。
      await page.evaluate((id) => window.__plein.engine.selection.set([id]), id)
      const edit = page.getByTestId('generator').getByRole('button', {
        name: type === 'plein/sequence' ? /^编辑序列/ : '编辑节奏样片',
      })
      await edit.press('Enter')
      await expect(editor).toBeVisible()
      await expect(players).toHaveCount(0)
      expect(
        await media!.evaluate((v: HTMLVideoElement) => ({
          paused: v.paused,
          src: v.getAttribute('src'),
          connected: v.isConnected,
        })),
      ).toEqual({ paused: true, src: null, connected: false })
      expect(await page.evaluate((id) => window.__plein.engine.doc.worldRect(id), id)).toEqual(
        before,
      )
      await media!.dispose()
      await page.keyboard.press('Escape')
      await expect(editor).toHaveCount(0)
    }
    // 播放期间双击另一个序列节点：编辑新节点并释放旧播放器。
    const other = await page.evaluate(() =>
      window.__plein.addNode({
        type: 'plein/sequence',
        name: '另一个序列',
        params: {},
        x: 800,
        y: 300,
      }),
    )
    await zoomTo(page, [id, other])
    await page.getByRole('button', { name: play!, exact: true }).click()
    const media = await players.locator('video').elementHandle()
    const point = await centerOf(page, other)
    await page.mouse.dblclick(point.x, point.y)
    await expect(editor).toBeVisible()
    await expect(players).toHaveCount(0)
    expect(
      await media!.evaluate(
        (v: HTMLVideoElement) => v.paused && !v.getAttribute('src') && !v.isConnected,
      ),
    ).toBe(true)
    await media!.dispose()
  })
}

test('普通视频与音频节点仍双击播放，退出释放媒体', async ({ page }) => {
  await newProject(page)
  const { id, assetId } = await fixture(page, 'plein/video')
  for (const kind of ['video', 'audio']) {
    await result(page, id, assetId, kind)
    const point = await centerOf(page, id)
    await page.mouse.dblclick(point.x, point.y)
    const player = page.locator('[data-player-el]')
    await expect(player).toHaveCount(1)
    const media = player.locator(kind)
    await expect.poll(() => media.evaluate((v: HTMLMediaElement) => !v.paused)).toBe(true)
    const handle = await media.elementHandle()
    await player.focus()
    await page.keyboard.press('Escape')
    await expect(player).toHaveCount(0)
    expect(
      await handle!.evaluate((v: HTMLMediaElement) => v.paused && !v.getAttribute('src')),
    ).toBe(true)
    await handle!.dispose()
  }
})
