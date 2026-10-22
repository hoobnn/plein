import { expect, type Page, test } from '@playwright/test'
import type { MediaDeriveRequest } from '../packages/protocol/src/media'
import { sineWav } from '../packages/providers/src/mock/media'
import { centerOf, newProject, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'audio/wav' },
    data: Buffer.from(sineWav(2)),
  })
  expect(upload.status()).toBe(201)
  const asset = (await upload.json()).id as string
  const source = await page.evaluate((asset) => {
    const e = window.__plein.engine as typeof window.__plein.engine & { paste(data: unknown): void }
    e.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'audio',
          name: '参数测试原音频',
          assetId: asset,
          x: 300,
          y: 200,
          w: 240,
          h: 96,
          parentId: null,
        },
      ],
    })
    return [...e.doc.elements()][0]!.id
  }, asset)
  await zoomTo(page, [source])
  const point = await centerOf(page, source)
  await page.mouse.click(point.x, point.y)
  const requests: MediaDeriveRequest[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/media/derive')) requests.push(r.postDataJSON())
  })
  return { asset, source, requests }
}

async function open(page: Page, operation: string) {
  await page
    .getByRole('toolbar', { name: '结果操作', exact: true })
    .getByRole('button', { name: '媒体工具', exact: true })
    .click()
  const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
  await tools.getByRole('button', { name: operation, exact: true }).click()
  return tools
}

test('截取拒绝无效入点，保留表单并可修正后生成真实片段', async ({ page }) => {
  const f = await fixture(page)
  const tools = await open(page, '截取一段')
  await tools.getByLabel('入点', { exact: true }).fill('oops')
  await tools.getByLabel('出点', { exact: true }).fill('0.6')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect(tools.getByRole('alert')).toContainText('入点时间看不懂')
  await expect(tools.getByLabel('入点', { exact: true })).toHaveValue('oops')
  await expect(tools.getByLabel('入点', { exact: true })).toBeFocused()
  await expect(tools.getByLabel('入点', { exact: true })).toHaveAttribute('aria-invalid', 'true')
  expect(f.requests).toEqual([])
  await tools.getByLabel('入点', { exact: true }).fill('0.2')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
    .toBe(2)
  expect(f.requests).toEqual([{ op: 'trim', assetId: f.asset, start: 0.2, end: 0.6 }])
  const out = await page.evaluate(
    (source) => [...window.__plein.engine.doc.elements()].find((e) => e.id !== source)!,
    f.source,
  )
  const meta = await (await page.request.get(`/api/assets/${out.assetId}/meta`)).json()
  expect(meta.duration).toBeCloseTo(0.4, 2)
})

test('变速拒绝空值、非数字和越界倍数，修正前不提交或关闭表单', async ({ page }) => {
  const f = await fixture(page)
  const tools = await open(page, '变速')
  for (const value of ['', 'oops', '0', '-1', '0.249', '4.01']) {
    await tools.getByLabel('倍数', { exact: true }).fill(value)
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('倍数需为 0.25–4 之间的数字')
    await expect(tools.getByLabel('倍数', { exact: true })).toHaveValue(value)
    await expect(tools.getByLabel('倍数', { exact: true })).toBeFocused()
    expect(f.requests).toEqual([])
  }
  await tools.getByRole('button', { name: '1.5×', exact: true }).click()
  await expect(tools.getByRole('alert')).toHaveCount(0)
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect.poll(() => f.requests.length).toBe(1)
  await expect(page.getByRole('button', { name: '取消加工', exact: true })).toHaveCount(0)
  expect(f.requests[0]).toMatchObject({ op: 'speed', speed: 1.5, assetId: f.asset })
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(2)
})

test('元信息迟到后截取默认区间可直接使用，不保留未加载时的零出点', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route(`**/api/assets/${f.asset}/meta`, async (route) => {
    await gate
    await route.continue()
  })
  try {
    const tools = await open(page, '截取一段')
    release()
    await expect(tools.getByLabel('出点', { exact: true })).toHaveAttribute('placeholder', '0:02')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect.poll(() => f.requests.length).toBe(1)
    expect(f.requests[0]).toEqual({ op: 'trim', assetId: f.asset, start: 0, end: 2 })
    await expect
      .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
      .toBe(2)
  } finally {
    release()
  }
})

test('窄窗口截取错误出点不发送请求，错误关联到字段，返回其他操作时清除', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 })
  const f = await fixture(page)
  const tools = await open(page, '截取一段')
  await expect(tools.getByLabel('出点', { exact: true })).toHaveAttribute('placeholder', '0:02')
  await tools.getByLabel('入点', { exact: true }).fill('0.2')
  for (const [value, message] of [
    ['', '出点时间看不懂'],
    ['oops', '出点时间看不懂'],
    ['0', '出点要大于入点'],
    ['0.1', '出点要大于入点'],
    ['3', '出点超出素材长度'],
  ]) {
    const end = tools.getByLabel('出点', { exact: true })
    await end.fill(value!)
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText(message!)
    await expect(end).toBeFocused()
    await expect(end).toHaveAttribute('aria-invalid', 'true')
    await expect(end).toHaveAccessibleDescription(new RegExp(message!))
    expect(f.requests).toEqual([])
  }
  await page.screenshot({ path: test.info().outputPath('trim-parameter-error.png') })
  await tools.getByRole('button', { name: '返回', exact: true }).click()
  await tools.getByRole('button', { name: '变速', exact: true }).click()
  await expect(tools.getByRole('alert')).toHaveCount(0)
  await expect(tools.getByLabel('倍数', { exact: true })).not.toHaveAttribute('aria-invalid')
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(1)
})

test('元信息加载期间手动填写的截取区间在返回后保持，实际按手动区间生成', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route(`**/api/assets/${f.asset}/meta`, async (route) => {
    await gate
    await route.continue()
  })
  try {
    const tools = await open(page, '截取一段')
    await tools.getByLabel('入点', { exact: true }).fill('0.25')
    await tools.getByLabel('出点', { exact: true }).fill('0.75')
    release()
    await expect(tools.getByLabel('出点', { exact: true })).toHaveAttribute('placeholder', '0:02')
    await expect(tools.getByLabel('出点', { exact: true })).toHaveValue('0.75')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect.poll(() => f.requests.length).toBe(1)
    expect(f.requests[0]).toEqual({ op: 'trim', assetId: f.asset, start: 0.25, end: 0.75 })
    await expect
      .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
      .toBe(2)
  } finally {
    release()
  }
})

test('读取时长的临时说明在元信息到达后退场，可直接重试默认截取', async ({ page }) => {
  const f = await fixture(page)
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  await page.route(`**/api/assets/${f.asset}/meta`, async (route) => {
    await gate
    await route.continue()
  })
  try {
    const tools = await open(page, '截取一段')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('正在读取素材时长')
    expect(f.requests).toEqual([])
    release()
    await expect(tools.getByLabel('出点', { exact: true })).toHaveAttribute('placeholder', '0:02')
    await expect(tools.getByRole('alert')).toHaveCount(0)
    await expect(tools.getByLabel('出点', { exact: true })).not.toHaveAttribute('aria-invalid')
    await tools.getByRole('button', { name: '开始加工', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => [...window.__plein.engine.doc.elements()].length))
      .toBe(2)
    expect(f.requests).toEqual([{ op: 'trim', assetId: f.asset, start: 0, end: 2 }])
  } finally {
    release()
  }
})
