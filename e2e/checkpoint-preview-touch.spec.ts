import { expect, type Page, test } from '@playwright/test'
import { article, checkpointPair, panel } from './checkpoints'

test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
async function setup(page: Page) {
  const f = await checkpointPair(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await article(page, f.second.name).getByRole('button', { name: '只读预览', exact: true }).click()
  const preview = panel(page).getByTestId('checkpoint-preview')
  const label = preview.getByText('预览原稿 第二版正文', { exact: true })
  await expect(label).toBeVisible()
  const canvas = (await preview.locator('canvas').boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  const active = new Set<number>()
  const touch = async (
    type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
    points: { id: number; x: number; y: number }[],
  ) => {
    if (type === 'touchCancel') expect(points).toHaveLength(0)
    if (type === 'touchCancel' && !active.size) return
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
    if (type === 'touchCancel' || (type === 'touchEnd' && !points.length)) active.clear()
    else
      for (const point of points) {
        if (type === 'touchEnd') active.delete(point.id)
        else active.add(point.id)
      }
  }
  return {
    ...f,
    preview,
    label,
    touch,
    cdp,
    errors,
    cx: canvas.x + canvas.width / 2,
    cy: canvas.y + canvas.height / 2,
  }
}

const mainCamera = (page: Page) =>
  page.evaluate(() => {
    const { x, y, zoom } = (
      window.__plein.engine as Window['__plein']['engine'] & {
        camera: { x: number; y: number; zoom: number }
      }
    ).camera
    return { x, y, zoom }
  })

test('预览单指拖动持续跟随手指，松手后不干扰原画布或文档', async ({ page }) => {
  const f = await setup(page)
  const before = (await f.label.boundingBox())!
  const camera = await mainCamera(page)
  try {
    await f.touch('touchStart', [{ id: 1, x: f.cx, y: f.cy }])
    for (let i = 1; i <= 6; i++)
      await f.touch('touchMove', [{ id: 1, x: f.cx + i * 8, y: f.cy + i * 4 }])
    await expect
      .poll(async () => {
        const after = (await f.label.boundingBox())!
        return Math.abs(after.x - before.x - 48) < 2 && Math.abs(after.y - before.y - 24) < 2
      })
      .toBe(true)
    await f.touch('touchEnd', [])
    await f.preview.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect
      .poll(async () => Math.abs((await f.label.boundingBox())!.x - before.x))
      .toBeLessThan(1)
    expect(await mainCamera(page)).toEqual(camera)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(f.errors).toEqual([])
  } finally {
    await f.touch('touchCancel', [])
    await f.cdp.detach()
  }
})

test('预览双指捏合按距离缩放，抬起一指后可连续单指平移且不跳变', async ({ page }) => {
  const f = await setup(page)
  const before = (await f.label.boundingBox())!
  const camera = await mainCamera(page)
  try {
    await f.touch('touchStart', [
      { id: 1, x: f.cx - 35, y: f.cy },
      { id: 2, x: f.cx + 35, y: f.cy },
    ])
    await f.touch('touchMove', [
      { id: 1, x: f.cx - 55, y: f.cy },
      { id: 2, x: f.cx + 55, y: f.cy },
    ])
    await expect
      .poll(async () => (await f.label.boundingBox())!.width / before.width)
      .toBeCloseTo(110 / 70, 1)
    const zoomed = (await f.label.boundingBox())!
    expect((f.cx - zoomed.x) / zoomed.width).toBeCloseTo((f.cx - before.x) / before.width, 2)
    expect((f.cy - zoomed.y) / zoomed.width).toBeCloseTo((f.cy - before.y) / before.width, 2)
    await f.preview.screenshot({
      path: test.info().outputPath('checkpoint-touch-pinch.png'),
      animations: 'disabled',
    })
    // 当前 Chromium 的单点 touchEnd 释放指定触点；空集合结束全部触点。
    await f.touch('touchEnd', [{ id: 2, x: f.cx + 55, y: f.cy }])
    await f.touch('touchMove', [{ id: 1, x: f.cx - 35, y: f.cy + 15 }])
    await expect
      .poll(async () => {
        const moved = (await f.label.boundingBox())!
        return {
          dx: Math.round(moved.x - zoomed.x),
          dy: Math.round(moved.y - zoomed.y),
          width: Math.round(moved.width - zoomed.width),
        }
      })
      .toMatchObject({ dx: 20, dy: 15, width: 0 })
    await f.touch('touchEnd', [])
    expect(await mainCamera(page)).toEqual(camera)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(f.errors).toEqual([])
  } finally {
    await f.touch('touchCancel', [])
    await f.cdp.detach()
  }
})

test('双指手势取消后可重新拖动，关闭预览期间松手不污染重开的版本', async ({ page }) => {
  const f = await setup(page)
  const camera = await mainCamera(page)
  try {
    await f.touch('touchStart', [
      { id: 1, x: f.cx - 30, y: f.cy },
      { id: 2, x: f.cx + 30, y: f.cy },
    ])
    await f.touch('touchMove', [
      { id: 1, x: f.cx - 40, y: f.cy },
      { id: 2, x: f.cx + 40, y: f.cy },
    ])
    await f.touch('touchCancel', [])
    await f.preview.getByRole('button', { name: '适应画布', exact: true }).click()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const before = (await f.label.boundingBox())!
    await f.touch('touchStart', [{ id: 3, x: f.cx, y: f.cy }])
    await f.touch('touchMove', [{ id: 3, x: f.cx + 30, y: f.cy + 20 }])
    await expect
      .poll(async () => Math.abs((await f.label.boundingBox())!.x - before.x - 30))
      .toBeLessThan(2)
    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    await f.touch('touchEnd', [])
    await page.getByRole('button', { name: '检查点', exact: true }).click()
    await article(page, f.first.name).getByRole('button', { name: '只读预览', exact: true }).click()
    await expect(panel(page).getByTestId('checkpoint-preview')).toContainText('第一版正文')
    expect(await mainCamera(page)).toEqual(camera)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(f.errors).toEqual([])
  } finally {
    await f.touch('touchCancel', [])
    await f.cdp.detach()
  }
})

test('双指操作中适应画布接管视角，旧手指移动不能覆盖新取景，松手后新手势可用', async ({ page }) => {
  const f = await setup(page)
  const before = (await f.label.boundingBox())!
  try {
    await f.touch('touchStart', [
      { id: 1, x: f.cx - 35, y: f.cy },
      { id: 2, x: f.cx + 35, y: f.cy },
    ])
    await f.touch('touchMove', [
      { id: 1, x: f.cx - 50, y: f.cy },
      { id: 2, x: f.cx + 50, y: f.cy },
    ])
    await expect
      .poll(async () => (await f.label.boundingBox())!.width)
      .toBeGreaterThan(before.width)
    await f.preview.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect
      .poll(async () => Math.abs((await f.label.boundingBox())!.width - before.width))
      .toBeLessThan(1)
    const fitted = (await f.label.boundingBox())!
    await f.touch('touchMove', [
      { id: 1, x: f.cx - 60, y: f.cy + 10 },
      { id: 2, x: f.cx + 60, y: f.cy + 10 },
    ])
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    expect(await f.label.boundingBox()).toEqual(fitted)
    await f.touch('touchEnd', [])
    await f.touch('touchStart', [{ id: 3, x: f.cx, y: f.cy }])
    await f.touch('touchMove', [{ id: 3, x: f.cx + 20, y: f.cy }])
    await expect
      .poll(async () => Math.abs((await f.label.boundingBox())!.x - fitted.x - 20))
      .toBeLessThan(2)
    await f.touch('touchEnd', [])
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(f.errors).toEqual([])
  } finally {
    await f.touch('touchCancel', [])
    await f.cdp.detach()
  }
})
