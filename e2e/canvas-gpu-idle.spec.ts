import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import type { Engine } from '../packages/canvas-core/src/engine'
import { createMediaFixture } from './perf/fixtures'
import { installFunctionSerialization, readMediaStats, waitEngine } from './perf/probe'

const sharp = createRequire(new URL('../apps/server/package.json', import.meta.url))(
  'sharp',
) as typeof import('../apps/server/node_modules/sharp').default

interface BufferStats {
  live: number
  created: number
  deleted: number
}

test('静止画布在真实 GPU 闲置期后释放缓冲，返回媒体无需重开画布', async ({ page, baseURL }) => {
  await installFunctionSerialization(page.context())
  // 只观测原生 create/delete，不保留缓冲强引用或替代产品的回收策略。
  await page.addInitScript(`(() => {
    const stats = { live: 0, created: 0, deleted: 0 };
    const tracked = new WeakSet();
    window.__gpuBufferStats = stats;
    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const proto = globalThis[name]?.prototype;
      if (!proto) continue;
      const create = proto.createBuffer, remove = proto.deleteBuffer;
      proto.createBuffer = function(...args) {
        const buffer = Reflect.apply(create, this, args);
        if (buffer && !tracked.has(buffer)) {
          tracked.add(buffer); stats.live++; stats.created++;
        }
        return buffer;
      };
      proto.deleteBuffer = function(buffer) {
        if (buffer && tracked.has(buffer)) {
          tracked.delete(buffer); stats.live--; stats.deleted++;
        }
        return Reflect.apply(remove, this, [buffer]);
      };
    }
  })()`)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const fixture = await createMediaFixture(baseURL!, {
    elements: 120,
    imageAssets: 8,
    video: false,
    audio: false,
  })
  const response = await page.request.post('/api/canvases', {
    data: { title: 'GPU 闲置回收验收' },
  })
  expect(response.ok()).toBe(true)
  const { id } = (await response.json()) as { id: string }
  await page.goto(`${baseURL}/#/c/${id}`)
  await waitEngine(page)
  const buffers = () =>
    page.evaluate(() => (window as unknown as { __gpuBufferStats: BufferStats }).__gpuBufferStats)
  await expect.poll(async () => (await buffers()).live).toBeGreaterThan(0)
  const empty = await buffers()
  await page.evaluate((data) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.paste(data)
    engine.selection.clear()
    engine.zoomToFit()
  }, fixture.data)
  await expect.poll(async () => (await readMediaStats(page)).previews.ready).toBe(120)
  const original = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  await expect.poll(async () => (await buffers()).live).toBeGreaterThan(empty.live + 16)
  const loaded = await buffers()
  await page.evaluate(() =>
    (window.__plein.engine as unknown as Engine).camera.lookAt(10000000, 10000000, 1),
  )
  await expect.poll(async () => (await readMediaStats(page)).residentBodies).toBe(0)
  const idleStart = Date.now()
  // 使用产品原有 60s 未使用期限及 30s 检查周期，不修改时间或主动触发渲染／GC。
  await page.waitForTimeout(95_000)
  const idle = await buffers()
  await test.info().attach('gpu-buffer-lifetime', {
    body: JSON.stringify({ empty, loaded, idle, elapsedMs: Date.now() - idleStart }, null, 2),
    contentType: 'application/json',
  })
  expect(idle.live).toBeLessThanOrEqual(empty.live + 8)
  expect(idle.deleted).toBeGreaterThan(loaded.deleted)
  await page.evaluate(() => window.__plein.engine.zoomToFit())
  await expect.poll(async () => (await readMediaStats(page)).previews.ready).toBe(120)
  const point = await page.evaluate(() => {
    const engine = window.__plein.engine
    const first = [...engine.doc.elements()].find((element) => element.kind === 'image')!
    const rect = engine.doc.worldRect(first.id)
    return engine.worldToClient(rect.x + rect.w / 2, rect.y + rect.h / 2)
  })
  await expect
    .poll(async () => {
      const { data, info } = await sharp(await page.screenshot({ scale: 'css' }))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const offset = (Math.floor(point.y) * info.width + Math.floor(point.x)) * 4
      return [158, 55, 121].every((value, index) => Math.abs(data[offset + index]! - value) <= 6)
    })
    .toBe(true)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(original)
  expect(errors).toEqual([])
})
