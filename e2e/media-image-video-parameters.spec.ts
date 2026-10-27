import { execFileSync } from 'node:child_process'
import { expect, type Page, test } from './fixtures'
import type { MediaDeriveRequest } from '../packages/protocol/src/media'
import { solidPng } from '../packages/providers/src/mock/media'
import { centerOf, newProject, zoomTo } from './canvas'

const videos = new Map<number, Buffer>()
test.beforeAll(() => {
  for (const duration of [0.4, 2])
    videos.set(
      duration,
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=teal:s=160x90:d=${duration}:r=10`,
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ]),
    )
})

async function fixture(page: Page, kind: 'image' | 'video', durations = [2]) {
  await newProject(page)
  const assets: string[] = []
  for (const duration of durations) {
    const upload = await page.request.post('/api/assets', {
      headers: { 'Content-Type': kind === 'image' ? 'image/png' : 'video/mp4' },
      data:
        kind === 'image' ? Buffer.from(solidPng(160, 90, [30, 140, 180])) : videos.get(duration)!,
    })
    expect(upload.status()).toBe(201)
    assets.push((await upload.json()).id)
  }
  const sources = await page.evaluate(
    ({ assets, kind }) => {
      const e = window.__plein.engine as typeof window.__plein.engine & {
        paste(data: unknown): void
      }
      e.paste({
        plein: 1,
        edges: [],
        elements: assets.map((asset, i) => ({
          id: `source-${i}`,
          kind,
          name: `${kind}原素材${i + 1}`,
          assetId: asset,
          x: 300 + i * 380,
          y: 200,
          w: 240,
          h: 135,
          parentId: null,
        })),
      })
      return [...e.doc.elements()].map((e) => e.id)
    },
    { assets, kind },
  )
  await zoomTo(page, sources)
  if (sources.length === 1) {
    const point = await centerOf(page, sources[0]!)
    await page.mouse.click(point.x, point.y)
  }
  const requests: MediaDeriveRequest[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/media/derive')) requests.push(r.postDataJSON())
  })
  const outputs = () =>
    page.evaluate(
      (sources) => [...window.__plein.engine.doc.elements()].filter((e) => !sources.includes(e.id)),
      sources,
    )
  return { assets, sources, requests, outputs }
}
async function open(page: Page, op: string, batch = false) {
  const label = batch ? '批量加工' : '媒体工具'
  await page.getByRole('button', { name: label, exact: true }).click()
  const tools = page.getByRole('dialog', { name: label, exact: true })
  await tools.getByRole('button', { name: new RegExp(`^${op}`) }).click()
  return tools
}

test('裁剪拒绝零尺寸、负值和小数，不静默改成一像素后加工', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  const f = await fixture(page, 'image')
  const tools = await open(page, '裁剪')
  for (const [label, value] of [
    ['宽', '0'],
    ['宽', '-3'],
    ['宽', '1.5'],
    ['高', '0'],
    ['左', '-1'],
    ['上', '0.2'],
  ]) {
    const input = tools.getByLabel(label!, { exact: true })
    await input.fill(value!)
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('整数')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(f.requests).toEqual([])
    if (label === '宽' && value === '0') {
      const color = await tools.getByRole('alert').evaluate((el) => getComputedStyle(el).color)
      await expect
        .poll(() => input.evaluate((el) => getComputedStyle(el).boxShadow))
        .toContain(color)
      await page.screenshot({ path: test.info().outputPath('crop-parameter-error.png') })
    }
    await input.fill(label === '左' || label === '上' ? '0' : label === '宽' ? '160' : '90')
  }
  await tools.getByLabel('宽', { exact: true }).fill('80')
  await tools.getByLabel('高', { exact: true }).fill('40')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect.poll(async () => (await f.outputs()).length).toBe(1)
  expect(f.requests).toEqual([
    { op: 'crop', assetId: f.assets[0], left: 0, top: 0, width: 80, height: 40 },
  ])
  const meta = await (
    await page.request.get(`/api/assets/${(await f.outputs())[0]!.assetId}/meta`)
  ).json()
  expect(meta).toMatchObject({ width: 80, height: 40 })
})

test('裁剪宽高留空表示从偏移位置到图片边缘，结果尺寸与原件及撤销一致', async ({ page }) => {
  const f = await fixture(page, 'image')
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const tools = await open(page, '裁剪')
  await expect(tools.getByLabel('宽', { exact: true })).toHaveAttribute('placeholder', '160')
  await tools.getByLabel('左', { exact: true }).fill('40')
  await tools.getByLabel('上', { exact: true }).fill('20')
  await tools.getByLabel('宽', { exact: true }).fill('')
  await tools.getByLabel('高', { exact: true }).fill('')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect.poll(async () => (await f.outputs()).length).toBe(1)
  expect(f.requests).toEqual([
    { op: 'crop', assetId: f.assets[0], left: 40, top: 20, width: 120, height: 70 },
  ])
  const meta = await (
    await page.request.get(`/api/assets/${(await f.outputs())[0]!.assetId}/meta`)
  ).json()
  expect(meta).toMatchObject({ width: 120, height: 70 })
  await page.keyboard.press('ControlOrMeta+z')
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(before)
})

test('视频抽帧的错误时间留在表单并聚焦，修正后可直接生成', async ({ page }) => {
  const f = await fixture(page, 'video')
  const tools = await open(page, '抽帧成图片')
  await tools.getByLabel('第几秒', { exact: true }).fill('oops')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect(tools.getByRole('alert')).toContainText('时间看不懂')
  await expect(tools.getByLabel('第几秒', { exact: true })).toBeFocused()
  expect(f.requests).toEqual([])
  await tools.getByLabel('第几秒', { exact: true }).fill('0.2')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect.poll(async () => (await f.outputs()).length).toBe(1)
  expect(f.requests).toEqual([{ op: 'frame', assetId: f.assets[0], at: 0.2 }])
})

test('单个视频抽帧在时长边界及越界时不提交，窄窗口保留纠错入口', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  const f = await fixture(page, 'video')
  // 先加载元信息，保证这条边界检查不依赖响应时序。
  const tools = await open(page, '截取一段')
  await expect(tools.getByLabel('出点', { exact: true })).toHaveValue('2')
  await tools.getByRole('button', { name: '返回', exact: true }).click()
  await tools.getByRole('button', { name: '抽帧成图片', exact: true }).click()
  for (const at of ['2', '2.1']) {
    await tools.getByLabel('第几秒', { exact: true }).fill(at)
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('早于视频末尾')
    await expect(tools.getByLabel('第几秒', { exact: true })).toBeFocused()
    expect(f.requests).toEqual([])
  }
  const color = await tools.getByRole('alert').evaluate((el) => getComputedStyle(el).color)
  await expect
    .poll(() =>
      tools.getByLabel('第几秒', { exact: true }).evaluate((el) => getComputedStyle(el).boxShadow),
    )
    .toContain(color)
  await page.screenshot({ path: test.info().outputPath('frame-parameter-error.png') })
})

test('批量抽帧不使用首个短视频的时长拒绝整个批次，保留长视频成功结果', async ({ page }) => {
  const f = await fixture(page, 'video', [0.4, 2])
  const tools = await open(page, '抽帧成图片', true)
  await tools.getByLabel('第几秒', { exact: true }).fill('0.6')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect.poll(async () => (await f.outputs()).length).toBe(1)
  await expect(page.getByRole('button', { name: '取消加工', exact: true })).toHaveCount(0)
  expect(f.requests).toEqual(f.assets.map((assetId) => ({ op: 'frame', assetId, at: 0.6 })))
  await expect(page.locator('.ui-toast')).toContainText('1 个成功，1 个失败：video原素材1')
})

test('图片尺寸迟到时说明读取状态，保留手动宽度并按剩余高度加工', async ({ page }) => {
  const f = await fixture(page, 'image')
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route(`**/api/assets/${f.assets[0]}/meta`, async (route) => {
    await gate
    await route.continue()
  })
  try {
    const tools = await open(page, '裁剪')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('正在读取素材尺寸')
    expect(f.requests).toEqual([])
    await tools.getByLabel('左', { exact: true }).fill('40')
    await tools.getByLabel('上', { exact: true }).fill('20')
    await tools.getByLabel('宽', { exact: true }).fill('80')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('正在读取素材尺寸')
    await expect(tools.getByLabel('高', { exact: true })).toBeFocused()
    expect(f.requests).toEqual([])
    release()
    await expect(tools.getByLabel('高', { exact: true })).toHaveValue('70')
    await expect(tools.getByLabel('宽', { exact: true })).toHaveValue('80')
    await expect(tools.getByRole('alert')).toHaveCount(0)
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect.poll(async () => (await f.outputs()).length).toBe(1)
    expect(f.requests).toEqual([
      { op: 'crop', assetId: f.assets[0], left: 40, top: 20, width: 80, height: 70 },
    ])
  } finally {
    release()
  }
})

test('视频像素裁剪拒绝奇数尺寸和越界，生成新视频且支持撤销', async ({ page }) => {
  const f = await fixture(page, 'video')
  const before = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
  const tools = await open(page, '裁剪')
  await expect(tools).toContainText('视频 160 × 90 像素')
  await expect(tools).toContainText('保留首条音轨，输出新 MP4')
  await tools.getByLabel('左', { exact: true }).fill('11')
  await tools.getByLabel('上', { exact: true }).fill('7')
  await tools.getByLabel('宽', { exact: true }).fill('99')
  await tools.getByLabel('高', { exact: true }).fill('56')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect(tools.getByRole('alert')).toContainText('宽度需为偶数')
  await expect(tools.getByLabel('宽', { exact: true })).toBeFocused()
  expect(f.requests).toEqual([])
  await tools.getByLabel('宽', { exact: true }).fill('160')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect(tools.getByRole('alert')).toContainText('超出视频宽度')
  expect(f.requests).toEqual([])
  await tools.getByLabel('宽', { exact: true }).fill('100')
  await page.screenshot({ path: test.info().outputPath('video-crop-pixels.png') })
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect.poll(async () => (await f.outputs()).length).toBe(1)
  expect(f.requests).toEqual([
    { op: 'crop', assetId: f.assets[0], left: 11, top: 7, width: 100, height: 56 },
  ])
  const out = (await f.outputs())[0]!
  expect(out.assetId).not.toBe(f.assets[0])
  const meta = await (await page.request.get(`/api/assets/${out.assetId}/meta`)).json()
  expect(meta).toMatchObject({ kind: 'video', width: 100, height: 56 })
  expect(meta.duration).toBeCloseTo(2, 1)
  expect(
    await page.evaluate(
      (id) => [...window.__plein.engine.doc.elements()].find((e) => e.id === id),
      f.sources[0]!,
    ),
  ).toEqual(before[0])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await f.outputs()).length).toBe(0)
})
