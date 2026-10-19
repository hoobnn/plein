import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
import { newProject, zoomTo } from './canvas'

async function fixture(page: Page, kind: 'image' | 'video' | 'audio' = 'image') {
  await newProject(page)
  const bytes =
    kind === 'image'
      ? Buffer.from(solidPng(160, 90, [40, 120, 180]))
      : kind === 'audio'
        ? Buffer.from(sineWav(0.5))
        : execFileSync('ffmpeg', [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=teal:s=160x90:d=0.5:r=10',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            'frag_keyframe+empty_moov',
            '-f',
            'mp4',
            'pipe:1',
          ])
  const response = await page.request.post('/api/assets', {
    headers: {
      'Content-Type': { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kind],
    },
    data: bytes,
  })
  expect(response.status()).toBe(201)
  const assetId = (await response.json()).id as string
  const id = await page.evaluate(
    ({ assetId, kind }) => {
      const engine = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      engine.paste({
        plein: 1,
        edges: [],
        elements: [
          {
            id: 'source',
            kind,
            name: '边缘素材',
            assetId,
            x: 400,
            y: 300,
            w: 240,
            h: 135,
            rotation: 0,
            locked: false,
            parentId: null,
          },
        ],
      })
      const id = [...engine.doc.elements()][0]!.id
      engine.selection.set([id])
      return id
    },
    { assetId, kind },
  )
  await zoomTo(page, [id])
  return { id, assetId, bar: page.getByRole('toolbar', { name: '结果操作', exact: true }) }
}

async function resize(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.waitForFunction(() => {
    const camera = (
      window.__plein.engine as typeof window.__plein.engine & {
        camera: { width: number; height: number }
      }
    ).camera
    return camera.width === innerWidth && camera.height === innerHeight
  })
}

async function fits(page: Page) {
  await page.waitForFunction(() => !document.documentElement.dataset.viewSlide)
  const bar = page.getByRole('toolbar', { name: '结果操作', exact: true })
  await expect
    .poll(
      () =>
        bar.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const sidebar = document.querySelector('[aria-label="侧栏"]')
          const left =
            sidebar?.getAttribute('aria-hidden') === 'true'
              ? 0
              : (sidebar?.getBoundingClientRect().right ?? 0)
          const right =
            document.querySelector('aside[aria-label="任务"]')?.getBoundingClientRect().left ??
            innerWidth
          return {
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            left,
            right,
            inside:
              r.x >= left + 4 &&
              r.right <= right - 4 &&
              r.y >= 64 &&
              r.bottom <= innerHeight - 64 &&
              el.scrollWidth <= el.clientWidth,
          }
        }),
      { timeout: 2000 },
    )
    .toMatchObject({ inside: true })
  await expect
    .poll(() =>
      bar.locator('button:enabled').evaluateAll((buttons) =>
        buttons.every((button) => {
          const r = button.getBoundingClientRect()
          return (
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') ===
            button
          )
        }),
      ),
    )
    .toBe(true)
}

for (const width of [1440, 900, 390, 320]) {
  test(`${width}px 图片操作条完整避让面板，审片和派生视频可用`, async ({ page }) => {
    const f = await fixture(page)
    await resize(page, { width, height: 900 })
    if (width === 900) await page.getByRole('button', { name: '任务', exact: true }).click()
    await zoomTo(page, [f.id])
    await fits(page)
    if (width === 900) {
      await page
        .getByRole('complementary', { name: '任务', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click()
      await fits(page)
      await page.getByRole('button', { name: '任务', exact: true }).click()
      await fits(page)
    }
    await page.screenshot({
      path: test.info().outputPath('result-toolbar.png'),
      animations: 'disabled',
    })
    await f.bar.getByRole('button', { name: '全屏查看', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '查看「边缘素材」', exact: true })
    await expect(viewer.getByRole('img', { name: '边缘素材', exact: true })).toHaveAttribute(
      'src',
      `/api/assets/${f.assetId}`,
    )
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await f.bar.getByRole('button', { name: '生成视频', exact: true }).click()
    const video = await page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/video'),
    )
    expect(video?.params?.mode).toBe('image')
    expect(await page.evaluate(() => [...window.__plein.engine.doc.edges()])).toContainEqual(
      expect.objectContaining({
        from: [f.id, 'image'],
        to: [video!.id, 'images'],
      }),
    )
  })
}

for (const kind of ['video', 'audio'] as const) {
  test(`${kind} 操作条在小窗口可打开加工菜单并恢复焦点`, async ({ page }) => {
    const f = await fixture(page, kind)
    await resize(page, { width: 390, height: 500 })
    await zoomTo(page, [f.id])
    await fits(page)
    const trigger = f.bar.getByRole('button', { name: '媒体工具', exact: true })
    await trigger.click()
    const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
    await expect(tools).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(tools).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.id])
  })
}

for (const { width, height } of [
  { width: 390, height: 500 },
  { width: 320, height: 320 },
]) {
  test(`${width}×${height} 图片靠近画布上下边缘时操作条仍完整可点击，平移不改素材`, async ({
    page,
  }) => {
    const f = await fixture(page)
    await resize(page, { width, height })
    const before = await page.evaluate((id) => window.__plein.engine.doc.get(id), f.id)
    for (const y of [460, 20]) {
      await page.evaluate(
        ({ id, y }) => {
          const engine = window.__plein.engine as typeof window.__plein.engine & {
            camera: { panBy(x: number, y: number): void }
          }
          const r = engine.doc.worldRect(id)
          const at = engine.worldToClient(r.x + r.w / 2, r.y + r.h)
          engine.camera.panBy(0, y - at.y)
        },
        { id: f.id, y },
      )
      await fits(page)
    }
    await f.bar.getByRole('button', { name: '媒体工具', exact: true }).click()
    const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
    await tools.getByRole('button', { name: '上下翻转', exact: true }).scrollIntoViewIfNeeded()
    await expect
      .poll(async () => {
        const r = (await tools.boundingBox())!
        return r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height
      })
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(tools).toHaveCount(0)
    await expect(f.bar.getByRole('button', { name: '媒体工具', exact: true })).toBeFocused()
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id), f.id)).toEqual(before)
  })
}

test('窄窗口可真实裁剪图片，原素材保持不变', async ({ page }) => {
  const f = await fixture(page)
  await resize(page, { width: 390, height: 700 })
  await zoomTo(page, [f.id])
  await fits(page)
  const before = await page.evaluate((id) => window.__plein.engine.doc.get(id), f.id)
  await f.bar.getByRole('button', { name: '媒体工具', exact: true }).click()
  const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
  await tools.getByRole('button', { name: '裁剪', exact: true }).click()
  const width = tools.getByLabel('宽', { exact: true })
  await expect(width).toHaveAttribute('placeholder', '160')
  await width.fill('80')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect(tools).toHaveCount(0)
  const images = () =>
    page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image'),
    )
  await expect.poll(async () => (await images()).length).toBe(2)
  const cropped = (await images()).find((el) => el.id !== f.id)!
  expect(cropped.assetId).not.toBe(f.assetId)
  const meta = await (await page.request.get(`/api/assets/${cropped.assetId}/meta`)).json()
  expect(meta).toMatchObject({ width: 80, height: 90 })
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id), f.id)).toEqual(before)
})
