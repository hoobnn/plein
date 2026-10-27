import { expect, type Locator, type Page, test } from './fixtures'
import { createRequire } from 'node:module'
import type { Engine } from '../packages/canvas-core/src/engine'
import { newProject, waitEngine } from './canvas'
import { article, openCheckpoints, panel } from './checkpoints'
import { readMediaStats } from './perf/probe'

const sharp = createRequire(new URL('../apps/server/package.json', import.meta.url))(
  'sharp',
) as typeof import('../apps/server/node_modules/sharp').default
type RGB = [number, number, number]
const colors: Array<{ name: string; rgb: RGB; alpha: number }> = [
  { name: 'pixel-red', rgb: [240, 35, 50], alpha: 1 },
  { name: 'pixel-green', rgb: [20, 200, 85], alpha: 1 },
  { name: 'pixel-blue', rgb: [30, 90, 235], alpha: 1 },
  { name: 'pixel-alpha', rgb: [240, 35, 50], alpha: 0.5 },
]
const composite = (rgb: RGB, alpha: number) =>
  rgb.map((v) => Math.round(v * alpha + 255 * (1 - alpha))) as RGB
const expected = [
  ...colors.map((c) => ({ name: c.name, rgb: composite(c.rgb, c.alpha) })),
  { name: 'pixel-node-red', rgb: colors[0]!.rgb },
  { name: 'pixel-node-alpha', rgb: composite(colors[3]!.rgb, 0.5) },
]
const matches = (data: Uint8Array, offset: number, rgb: RGB) =>
  rgb.every((v, i) => Math.abs(data[offset + i]! - v) <= 6) && data[offset + 3] === 255

async function assertMainPixels(page: Page) {
  await expect
    .poll(async () => {
      const points = await page.evaluate((expected) => {
        const engine = window.__plein.engine as unknown as Engine
        return expected.map(({ name }) => {
          const el = [...engine.doc.elements()].find((e) => e.name === name)!
          const r = engine.doc.worldRect(el.id)!
          return engine.worldToClient(r.x + r.w / 2, r.y + r.h / 2)
        })
      }, expected)
      const { data, info } = await sharp(await page.screenshot({ scale: 'css' }))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      return points.map(
        (p, i) =>
          p.x >= 0 &&
          p.y >= 0 &&
          p.x < info.width &&
          p.y < info.height &&
          matches(data, (Math.floor(p.y) * info.width + Math.floor(p.x)) * 4, expected[i]!.rgb),
      )
    })
    .toEqual(expected.map(() => true))
}

async function assertPreviewPixels(page: Page) {
  const canvas = panel(page).getByTestId('checkpoint-preview').locator('canvas')
  await expect(canvas).toBeVisible()
  await expect
    .poll(async () => {
      const data = await sharp(await canvas.screenshot({ scale: 'css' }))
        .ensureAlpha()
        .raw()
        .toBuffer()
      const counts = colors.map(() => 0)
      for (let p = 0; p < data.length; p += 4)
        for (let i = 0; i < colors.length; i++) if (matches(data, p, expected[i]!.rgb)) counts[i]!++
      return counts.map((n) => n >= 200)
    })
    .toEqual(colors.map(() => true))
}

async function loseAndRestoreContext(canvas: Locator) {
  await canvas.evaluate(async (element) => {
    const gl = (element as HTMLCanvasElement).getContext('webgl2')!
    const extension = gl.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('WEBGL_lose_context is unavailable')
    const lost = new Promise<void>((resolve) =>
      element.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    )
    extension.loseContext()
    await lost
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const restored = new Promise<void>((resolve) =>
      element.addEventListener('webglcontextrestored', () => resolve(), { once: true }),
    )
    extension.restoreContext()
    await restored
  })
}

test('上传预览的颜色与半透明合成在缩放、检查点销毁及恢复后保持正确', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await newProject(page)
  await page.getByRole('button', { name: '浅色', exact: true }).click()
  const assets = await Promise.all(
    colors.map(async (c) => {
      const png = await sharp({
        create: {
          width: 128,
          height: 96,
          channels: 4,
          background: { r: c.rgb[0], g: c.rgb[1], b: c.rgb[2], alpha: c.alpha },
        },
      })
        .png()
        .toBuffer()
      const response = await page.request.post('/api/assets', {
        headers: {
          'content-type': 'image/png',
          'x-file-name': encodeURIComponent(c.name + '.png'),
        },
        data: png,
      })
      expect(response.ok()).toBe(true)
      return { name: c.name, id: (await response.json()).id as string }
    }),
  )
  await page.evaluate((assets) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.paste({
      plein: 1,
      elements: assets.map((a, i) => ({
        id: a.name,
        kind: 'image' as const,
        name: a.name,
        assetId: a.id,
        x: (i % 2) * 220,
        y: Math.floor(i / 2) * 200,
        w: 160,
        h: 120,
        rotation: 0,
        parentId: null,
        locked: false,
        z: 'a0',
      })),
      edges: [],
    })
    const anchor = [...engine.doc.elements()].find((e) => e.name === 'pixel-red')!
    for (const [i, asset] of [assets[0]!, assets[3]!].entries()) {
      const name = i === 0 ? 'pixel-node-red' : 'pixel-node-alpha'
      const id = window.__plein.addNode({
        type: 'plein/image',
        name,
        params: { prompt: 'uploaded pixel fixture', model: 'plein/mock:image' },
        x: anchor.x + 440,
        y: anchor.y + i * 200,
      })
      const m = engine.doc.mutable(id)!
      m.set('w', 160)
      m.set('h', 160)
      m.set('results', [
        {
          id: 'pixel-result-' + i,
          port: 'images',
          runId: 'pixel-fixture-' + i,
          at: 1,
          value: { type: 'image', assetId: asset.id },
        },
      ])
      m.set('adopted', 'pixel-result-' + i)
    }
    engine.doc.flush()
    engine.selection.clear()
    engine.zoomToFit()
  }, assets)
  await expect.poll(async () => (await readMediaStats(page)).previews.ready).toBe(6)
  await assertMainPixels(page)
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const zoom = await page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.zoom)
  const center = await page.locator('canvas').boundingBox()
  await page.mouse.move(center!.x + center!.width / 2, center!.y + center!.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 180)
  await page.keyboard.up('Control')
  await expect
    .poll(() => page.evaluate(() => (window.__plein.engine as unknown as Engine).camera.zoom))
    .toBeLessThan(zoom)
  await assertMainPixels(page)
  await loseAndRestoreContext(page.locator('canvas').first())
  await assertMainPixels(page)
  await openCheckpoints(page)
  await panel(page).getByRole('textbox', { name: '检查点名称', exact: true }).fill('像素校验')
  await panel(page).getByRole('button', { name: '保存当前画布', exact: true }).click()
  await expect(article(page, '像素校验')).toBeVisible()
  await assertPreviewPixels(page)
  await loseAndRestoreContext(panel(page).getByTestId('checkpoint-preview').locator('canvas'))
  await assertPreviewPixels(page)
  await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await assertMainPixels(page)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
  await expect.poll(async () => (await readMediaStats(page)).textures.owners).toBe(1)
  const originalId = page.url().split('#/c/')[1]!
  const retired = await page.evaluateHandle(() => window.__plein.engine)
  try {
    await openCheckpoints(page)
    await article(page, '像素校验')
      .getByRole('button', { name: '恢复为新画布', exact: true })
      .click()
    await expect(page).not.toHaveURL(new RegExp(originalId))
    await expect
      .poll(() =>
        page.evaluate((old) => !!window.__plein && window.__plein.engine !== old, retired),
      )
      .toBe(true)
    await waitEngine(page)
    if (await panel(page).isVisible())
      await panel(page).getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(async () => (await readMediaStats(page)).textures.owners).toBe(1)
    await expect.poll(async () => (await readMediaStats(page)).previews.ready).toBe(6)
    await assertMainPixels(page)
    expect(errors).toEqual([])
    await page.screenshot({ path: test.info().outputPath('preview-pixels-restored.png') })
  } finally {
    await retired.dispose()
  }
})
