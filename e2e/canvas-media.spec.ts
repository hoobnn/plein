import { expect, test } from './fixtures'
import { createMediaFixture, seedMediaCanvas } from './perf/fixtures'
import {
  installOpenProbe,
  readMediaStats,
  readOpenSample,
  type PerfPageWindow,
  watchAssetRequests,
} from './perf/probe'

test('真实媒体低缩放只取小图，离屏及退出画布后释放资源', async ({ browser, page, baseURL }) => {
  const base = baseURL!
  const fixture = await createMediaFixture(base, { elements: 400, imageAssets: 8 })
  const canvas = await seedMediaCanvas(page, base, fixture)
  await page.goto(`${base}/#/`)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const cold = await context.newPage()
  const network = watchAssetRequests(cold)
  const errors: string[] = []
  cold.on('pageerror', (error) => errors.push(error.message))
  try {
    await installOpenProbe(cold, fixture.elements)
    await cold.goto(`${base}/#/c/${canvas}`)
    const open = await readOpenSample(cold, network.requests)
    expect(open.firstVisiblePreviewMs).toBeGreaterThanOrEqual(open.engineReadyMs)
    expect(open.visibleMediaSettledMs).toBeGreaterThanOrEqual(open.firstVisiblePreviewMs)
    expect(open.stats.previews).toMatchObject({ total: 400, ready: 400, pending: 0, failed: 0 })
    expect(open.requests.failed).toBe(0)
    expect(open.requests.variants['thumb-256']).toBeGreaterThan(0)
    expect(open.requests.variants['thumb-1024'] ?? 0).toBe(0)
    expect(open.requests.variants.poster).toBeGreaterThan(0)
    expect(open.requests.variants.waveform).toBeGreaterThan(0)

    await cold.evaluate(() => {
      const engine = (
        window as unknown as {
          __plein: { engine: { camera: { lookAt(x: number, y: number, zoom: number): void } } }
        }
      ).__plein.engine
      engine.camera.lookAt(100, 100, 1)
    })
    await expect
      .poll(async () => (await readMediaStats(cold)).offscreenBodies)
      .toBeLessThanOrEqual(256)
    await expect.poll(async () => (await readMediaStats(cold)).offscreenBodies).toBe(0)
    const stats = await readMediaStats(cold)
    expect(stats.residentBodies).toBe(stats.visibleBodies)
    expect(stats.textures.idleTextures).toBeLessThanOrEqual(128)
    expect(stats.textures.activeLeases).toBeLessThanOrEqual(stats.visibleBodies * 2)
    expect(stats.textures.unloadErrors).toBe(0)

    await cold.evaluate(() => {
      const state = window as unknown as PerfPageWindow
      const engine = state.__plein!.engine
      state.__retiredMediaStats = () => engine.stats
      location.hash = '#/'
    })
    await cold.waitForFunction(() => !(window as unknown as PerfPageWindow).__plein)
    await expect
      .poll(() =>
        cold.evaluate(() => (window as unknown as PerfPageWindow).__retiredMediaStats!().textures),
      )
      .toMatchObject({
        owners: 0,
        activeLeases: 0,
        queuedLoads: 0,
        inFlightLoads: 0,
        readyTextures: 0,
        unloadingTextures: 0,
      })
    expect(errors).toEqual([])
  } finally {
    network.stop()
    await context.close()
  }
})

test('真实预览请求失败会让首屏验收失败，不把引擎就绪当媒体成功', async ({
  browser,
  page,
  baseURL,
}) => {
  const base = baseURL!
  const fixture = await createMediaFixture(base, {
    elements: 4,
    imageAssets: 1,
    video: false,
    audio: false,
  })
  const canvas = await seedMediaCanvas(page, base, fixture)
  await page.goto(`${base}/#/`)
  const context = await browser.newContext()
  const cold = await context.newPage()
  const network = watchAssetRequests(cold)
  try {
    await cold.route('**/api/assets/*/thumb-*', (route) =>
      route.fulfill({ status: 503, body: 'fixture offline' }),
    )
    await installOpenProbe(cold, fixture.elements)
    await cold.goto(`${base}/#/c/${canvas}`)
    await expect(readOpenSample(cold, network.requests)).rejects.toThrow(
      /Media preview failed|Media HTTP failures/,
    )
    expect((await readMediaStats(cold)).previews.failed).toBeGreaterThan(0)
  } finally {
    network.stop()
    await context.close()
  }
})
