import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'
import type { MediaDeriveRequest } from '../packages/protocol/src/media'
import { sineWav, solidPng } from '../packages/providers/src/mock/media'
import { newProject, zoomTo } from './canvas'

type Kind = 'image' | 'video' | 'audio'
let video: Buffer
test.beforeAll(() => {
  video = execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=160x90:d=0.8:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=0.8',
    '-shortest',
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
})
async function fixture(page: Page, order: Kind[]) {
  await newProject(page)
  const assets = Object.fromEntries(
    await Promise.all(
      (['image', 'video', 'audio'] as const).map(async (kind) => {
        const response = await page.request.post('/api/assets', {
          headers: {
            'Content-Type': { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kind],
          },
          data:
            kind === 'image'
              ? Buffer.from(solidPng(160, 90, [30, 140, 180]))
              : kind === 'video'
                ? video
                : Buffer.from(sineWav(0.8)),
        })
        expect(response.status()).toBe(201)
        return [kind, (await response.json()).id as string]
      }),
    ),
  ) as Record<Kind, string>
  const ids = await page.evaluate(
    ({ assets, order }) => {
      const e = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      e.paste({
        plein: 1,
        edges: [],
        elements: order.map((kind, i) => ({
          id: kind,
          kind,
          name: `${kind}原素材`,
          assetId: assets[kind],
          parentId: null,
          x: 300 + i * 380,
          y: 200,
          w: 240,
          h: kind === 'audio' ? 96 : 135,
        })),
      })
      return [...e.doc.elements()].map((el) => el.id)
    },
    { assets, order },
  )
  await zoomTo(page, ids)
  return { assets, ids }
}
async function menu(page: Page) {
  await page.getByRole('button', { name: '批量加工', exact: true }).click()
  return page.getByRole('dialog', { name: '批量加工', exact: true })
}
for (const first of ['image', 'video', 'audio'] as const) {
  test(`混选图片音视频以 ${first} 开头时，各项操作和适用数量不依赖选取顺序`, async ({ page }) => {
    const order = [
      first,
      ...(['image', 'video', 'audio'] as const).filter((kind) => kind !== first),
    ]
    await fixture(page, order)
    const tools = await menu(page)
    for (const name of ['旋转 90°', '左右翻转', '变速', '分离音频与画面', '抽帧成图片'])
      await expect(tools.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
    await expect(tools.getByRole('button', { name: /^旋转 90°/ })).toContainText('1 张图片')
    await expect(tools.getByRole('button', { name: /^变速/ })).toContainText('2 段音视频')
    await expect(tools.getByRole('button', { name: /^分离音频与画面/ })).toContainText('1 段视频')
  })
}
test('混合批量旋转只提交图片，明确未处理的素材，原件不变且可独立撤销', async ({ page }) => {
  const f = await fixture(page, ['image', 'video', 'audio'])
  const requests: MediaDeriveRequest[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/media/derive')) requests.push(request.postDataJSON())
  })
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const tools = await menu(page)
  await tools.getByRole('button', { name: /^旋转 90°/ }).click()
  await expect.poll(() => requests.length).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: '取消加工', exact: true })).toHaveCount(0)
  expect(requests).toEqual([{ op: 'rotate', assetId: f.assets.image, angle: 90 }])
  await expect(page.locator('.ui-toast')).toContainText('2 个不适用素材未处理')
  const after = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  expect(after.filter((el) => f.ids.includes(el.id))).toEqual(before)
  const result = after.find((el) => !f.ids.includes(el.id))!
  expect(await (await page.request.get(`/api/assets/${result.assetId}/meta`)).json()).toMatchObject(
    { width: 90, height: 160 },
  )
  await page.keyboard.press('ControlOrMeta+z')
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
})

test('混合批量变速只处理音视频，音频选项可见并产出正确时长', async ({ page }) => {
  const f = await fixture(page, ['image', 'video', 'audio'])
  const requests: MediaDeriveRequest[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/media/derive')) requests.push(r.postDataJSON())
  })
  const tools = await menu(page)
  await tools.getByRole('button', { name: /^变速/ }).click()
  await tools.getByLabel('倍数', { exact: true }).fill('2')
  await tools.getByRole('checkbox', { name: /保留音频素材的音调/ }).uncheck()
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  const outputs = () =>
    page.evaluate(
      (ids) => [...window.__plein.engine.doc.elements()].filter((el) => !ids.includes(el.id)),
      f.ids,
    )
  await expect.poll(async () => (await outputs()).length).toBe(2)
  await expect(page.getByRole('button', { name: '取消加工', exact: true })).toHaveCount(0)
  expect(requests).toEqual([
    { op: 'speed', assetId: f.assets.video, speed: 2, keepPitch: false },
    { op: 'speed', assetId: f.assets.audio, speed: 2, keepPitch: false },
  ])
  expect((await outputs()).map((el) => el.kind)).toEqual(['video', 'audio'])
  for (const out of await outputs()) {
    const meta = await (await page.request.get(`/api/assets/${out.assetId}/meta`)).json()
    expect(meta.duration).toBeGreaterThan(0.25)
    expect(meta.duration).toBeLessThan(0.55)
  }
  await expect(page.locator('.ui-toast')).toContainText('1 个不适用素材未处理')
})
test('混合选择抽帧只引用视频，实际画面来自视频而非所选图片', async ({ page }) => {
  const f = await fixture(page, ['audio', 'image', 'video'])
  const requests: MediaDeriveRequest[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/media/derive')) requests.push(r.postDataJSON())
  })
  const tools = await menu(page)
  await tools.getByRole('button', { name: /^抽帧成图片/ }).click()
  await tools.getByLabel('第几秒', { exact: true }).fill('0.3')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(4)
  expect(requests).toEqual([{ op: 'frame', assetId: f.assets.video, at: 0.3 }])
  const out = await page.evaluate(
    (ids) => [...window.__plein.engine.doc.elements()].find((el) => !ids.includes(el.id))!,
    f.ids,
  )
  const bytes = await (await page.request.get(`/api/assets/${out.assetId}`)).body()
  const pixels = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { input: bytes },
  )
  expect(pixels[0]).toBeLessThan(10)
  expect(pixels[1]).toBeGreaterThan(110)
  expect(pixels[1]).toBeLessThan(145)
  expect(pixels[2]).toBeGreaterThan(110)
  expect(pixels[2]).toBeLessThan(145)
  await expect(page.locator('.ui-toast')).toContainText('2 个不适用素材未处理')
})
test('没有音视频加工能力时，窄窗口混选仍可操作图片并显示准确范围', async ({ page }) => {
  await page.route('**/api/media/caps', (route) =>
    route.fulfill({ json: { ffmpeg: false, subtitles: false, rubberband: false } }),
  )
  const f = await fixture(page, ['audio', 'video', 'image'])
  await page.setViewportSize({ width: 390, height: 700 })
  await page.waitForFunction(() => {
    const camera = (
      window.__plein.engine as unknown as { camera: { width: number; height: number } }
    ).camera
    return camera.width === innerWidth && camera.height === innerHeight
  })
  await zoomTo(page, f.ids)
  const tools = await menu(page)
  await expect(tools.getByRole('button', { name: /^变速/ })).toHaveCount(0)
  await expect(tools.getByRole('button', { name: /^分离音频与画面/ })).toHaveCount(0)
  await expect(tools.getByRole('button', { name: /^旋转 90°/ })).toContainText('1 张图片')
  const box = (await tools.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await page.screenshot({
    path: test.info().outputPath('mixed-media-narrow.png'),
    animations: 'disabled',
  })
})
test('混合变速部分失败明确失败来源，重新选择失败音频可恢复而不重做成功视频', async ({ page }) => {
  const f = await fixture(page, ['audio', 'image', 'video'])
  const requests: MediaDeriveRequest[] = []
  let failed = false
  await page.route('**/api/media/derive', async (route) => {
    const input = route.request().postDataJSON() as MediaDeriveRequest
    requests.push(input)
    if (input.assetId === f.assets.audio && !failed) {
      failed = true
      return route.fulfill({ status: 503, json: { message: '测试音频暂时失败' } })
    }
    return route.continue()
  })
  const tools = await menu(page)
  await tools.getByRole('button', { name: /^变速/ }).click()
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect(page.locator('.ui-toast')).toContainText(
    '1 个成功，1 个失败：audio原素材：测试音频暂时失败',
  )
  await expect(page.locator('.ui-toast')).toContainText('1 个不适用素材未处理')
  const succeeded = await page.evaluate(
    (ids) => [...window.__plein.engine.doc.elements()].find((el) => !ids.includes(el.id))!,
    f.ids,
  )
  expect(succeeded.kind).toBe('video')
  await page.getByRole('treeitem', { name: 'audio原素材 定位到画布', exact: true }).click()
  await page.getByRole('button', { name: '媒体工具', exact: true }).click()
  const retry = page.getByRole('dialog', { name: '媒体工具', exact: true })
  await retry.getByRole('button', { name: /^变速/ }).click()
  await retry.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(5)
  expect(requests.map((r) => r.assetId)).toEqual([f.assets.audio, f.assets.video, f.assets.audio])
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id), succeeded.id)).toEqual(
    succeeded,
  )
})

test('320px 低窗口混合菜单可滚动访问末项，返回后继续修改批量设置', async ({ page }) => {
  const f = await fixture(page, ['image', 'audio', 'video'])
  await page.setViewportSize({ width: 320, height: 320 })
  await page.waitForFunction(() => {
    const camera = (
      window.__plein.engine as unknown as { camera: { width: number; height: number } }
    ).camera
    return camera.width === innerWidth && camera.height === innerHeight
  })
  await zoomTo(page, f.ids)
  const tools = await menu(page)
  const frame = tools.getByRole('button', { name: /^抽帧成图片/ })
  await frame.scrollIntoViewIfNeeded()
  await expect
    .poll(async () => {
      const box = (await tools.boundingBox())!
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 320
    })
    .toBe(true)
  await frame.click()
  await expect(tools.getByLabel('第几秒', { exact: true })).toBeVisible()
  await tools.getByRole('button', { name: '返回', exact: true }).click()
  await tools.getByRole('button', { name: /^变速/ }).click()
  await expect(tools.locator('.ui-menu-label')).toBeInViewport({ ratio: 1 })
  const speed = tools.getByLabel('倍数', { exact: true })
  await speed.fill('1.5')
  await expect(speed).toHaveValue('1.5')
  await tools.getByRole('button', { name: '开始加工', exact: true }).scrollIntoViewIfNeeded()
  await expect(tools.getByRole('button', { name: '开始加工', exact: true })).toBeInViewport({
    ratio: 1,
  })
  await page.screenshot({
    path: test.info().outputPath('mixed-media-low.png'),
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await expect(tools).toHaveCount(0)
  await expect(page.getByRole('button', { name: '批量加工', exact: true })).toBeFocused()
})

test('能力信息迟到使当前操作不可用时，说明原因并可返回加工图片', async ({ page }) => {
  let release!: () => void,
    entered = false,
    submitted = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/media/caps', async (route) => {
    entered = true
    await gate
    await route
      .fulfill({ json: { ffmpeg: false, subtitles: false, rubberband: false } })
      .catch(() => {})
  })
  page.on('request', (r) => {
    if (r.url().endsWith('/api/media/derive')) submitted++
  })
  try {
    await fixture(page, ['audio', 'image', 'video'])
    await expect.poll(() => entered).toBe(true)
    const tools = await menu(page)
    await tools.getByRole('button', { name: /^变速/ }).click()
    const start = tools.getByRole('button', { name: '开始加工', exact: true })
    await expect(start).toBeEnabled()
    release()
    await expect(start).toBeDisabled()
    await expect(tools.getByRole('alert')).toContainText('当前环境暂不支持此操作')
    expect(submitted).toBe(0)
    await tools.getByRole('button', { name: '返回', exact: true }).click()
    await tools.getByRole('button', { name: /^旋转 90°/ }).click()
    await expect(page.locator('.ui-toast')).toContainText('2 个不适用素材未处理')
    expect(submitted).toBe(1)
  } finally {
    release()
  }
})
