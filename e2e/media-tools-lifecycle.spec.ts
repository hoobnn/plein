import { expect, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, waitEngine, zoomTo } from './canvas'

async function fixture(page: Page) {
  await newProject(page)
  const upload = await page.request.post('/api/assets', {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(solidPng(160, 90, [30, 140, 180])),
  })
  expect(upload.status()).toBe(201)
  const asset = (await upload.json()).id as string
  const ids = await page.evaluate((asset) => {
    const e = window.__plein.engine as typeof window.__plein.engine & { paste(data: unknown): void }
    e.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'image',
          name: '加工原图',
          assetId: asset,
          x: 300,
          y: 200,
          w: 240,
          h: 135,
          parentId: null,
        },
      ],
    })
    const source = [...e.doc.elements()][0]!.id
    const other = window.__plein.addNode({
      type: 'plein/image',
      name: '继续编辑的任务',
      params: { prompt: '保留草稿' },
      x: 800,
      y: 200,
    })
    return { source, other }
  }, asset)
  await zoomTo(page, [ids.source, ids.other])
  await page.getByRole('treeitem', { name: '加工原图 定位到画布', exact: true }).click()
  return { ...ids, asset }
}
async function start(page: Page) {
  await page
    .getByRole('toolbar', { name: '结果操作', exact: true })
    .getByRole('button', { name: '媒体工具', exact: true })
    .click()
  const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
  const crop = tools.getByRole('button', { name: '裁剪', exact: true })
  if (await crop.count()) await crop.click()
  await expect(tools.getByLabel('宽', { exact: true })).toHaveAttribute('placeholder', '160')
  await tools.getByLabel('宽', { exact: true }).fill('80')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
}
async function hold(page: Page, failure = false) {
  let release!: () => void,
    ready = false,
    finished = false
  const waiting = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/media/derive', async (route) => {
    const response = await route.fetch()
    ready = true
    await waiting
    await (
      failure
        ? route.fulfill({ status: 500, json: { message: '测试旧加工失败' } })
        : route.fulfill({ response })
    ).catch(() => {})
    finished = true
  })
  return { release, ready: () => ready, finished: () => finished }
}
for (const change of ['delete', 'replace'] as const) {
  test(`图片加工等待时${change === 'delete' ? '删除' : '替换'}来源，不写入失效产物`, async ({
    page,
  }) => {
    const f = await fixture(page)
    const replacement =
      change === 'replace'
        ? ((
            await (
              await page.request.post('/api/assets', {
                headers: { 'Content-Type': 'image/png' },
                data: Buffer.from(solidPng(90, 160, [180, 100, 30])),
              })
            ).json()
          ).id as string)
        : ''
    const held = await hold(page)
    try {
      await start(page)
      await expect.poll(held.ready).toBe(true)
      await page.evaluate(
        ({ source, change, replacement }) => {
          const e = window.__plein.engine as typeof window.__plein.engine & {
            deleteSelection(): void
          }
          if (change === 'delete') {
            e.selection.set([source])
            e.deleteSelection()
          } else
            (e.doc.mutable(source) as unknown as { set(key: string, value: unknown): void }).set(
              'assetId',
              replacement,
            )
        },
        { source: f.source, change, replacement },
      )
      held.release()
      await expect.poll(held.finished).toBe(true)
      await expect(page.locator('.ui-toast')).toContainText('素材已变化')
      expect(
        await page.evaluate(
          () =>
            [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
        ),
      ).toBe(change === 'delete' ? 0 : 1)
    } finally {
      held.release()
    }
  })
}
test('图片加工后台完成保留其他任务的选择和提示词，提供手动定位', async ({ page }) => {
  const f = await fixture(page)
  const held = await hold(page)
  try {
    await start(page)
    await expect.poll(held.ready).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('treeitem', { name: '继续编辑的任务 定位到画布', exact: true }).click()
    const prompt = page
      .getByTestId('generator')
      .getByRole('textbox', { name: '提示词', exact: true })
    await prompt.fill('继续写这段草稿')
    held.release()
    await expect.poll(held.finished).toBe(true)
    await expect(page.getByRole('button', { name: '定位新素材', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([f.other])
    await expect(prompt).toHaveValue('继续写这段草稿')
    await page.getByRole('button', { name: '定位新素材', exact: true }).click()
    const selected = await page.evaluate(() =>
      window.__plein.engine.doc.get(window.__plein.engine.selection.values()[0]!),
    )
    expect(selected?.kind).toBe('image')
    expect(selected?.assetId).not.toBe(f.asset)
    const meta = await (await page.request.get(`/api/assets/${selected!.assetId}/meta`)).json()
    expect(meta).toMatchObject({ width: 80, height: 90 })
  } finally {
    held.release()
  }
})

for (const failure of [false, true]) {
  test(`切换画布后旧加工${failure ? '失败' : '成功'}不写入或打断新画布`, async ({ page }) => {
    const f = await fixture(page)
    const origin = decodeURIComponent(page.url().split('#/c/')[1]!)
    const canvas = await (await page.request.get(`/api/canvases/${origin}`)).json()
    const other = await (
      await page.request.post('/api/canvases', {
        data: { projectId: canvas.projectId, title: '加工等待的新画布' },
      })
    ).json()
    const held = await hold(page, failure)
    try {
      await start(page)
      await expect.poll(held.ready).toBe(true)
      await page.goto(`/#/c/${other.id}`)
      await waitEngine(page)
      held.release()
      await expect.poll(held.finished).toBe(true)
      expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toHaveLength(0)
      expect((await page.locator('.ui-toast').allTextContents()).join('')).not.toMatch(
        /裁剪|测试旧加工失败|已取消加工/,
      )
      await page.goto(`/#/c/${origin}`)
      await waitEngine(page)
      expect(
        await page.evaluate(() =>
          [...window.__plein.engine.doc.elements()]
            .filter((el) => el.kind === 'image')
            .map((el) => el.id),
        ),
      ).toEqual([f.source])
    } finally {
      held.release()
    }
  })
}
test('窄窗口切回原素材仍显示等待，取消中止读取并可重试，产物独立撤销', async ({ page }) => {
  const f = await fixture(page)
  await page.setViewportSize({ width: 390, height: 700 })
  await zoomTo(page, [f.source])
  const held = await hold(page)
  let failed = false,
    submitted = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/media/derive')) submitted++
  })
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/api/media/derive')) failed = true
  })
  try {
    await start(page)
    await expect.poll(held.ready).toBe(true)
    for (const name of ['继续编辑的任务', '加工原图']) {
      const item = page.getByRole('treeitem', { name: `${name} 定位到画布`, exact: true })
      if (!(await item.count()))
        await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
      await item.click()
    }
    const collapse = page.getByRole('button', { name: '收起侧栏', exact: true })
    if (await collapse.count()) await collapse.click()
    const tools = page.getByRole('button', { name: '媒体工具', exact: true })
    await expect(tools).toBeDisabled()
    await expect(page.getByRole('button', { name: '取消加工', exact: true })).toBeVisible()
    expect(submitted).toBe(1)
    await zoomTo(page, [f.source])
    const cancelBox = (await page
      .getByRole('button', { name: '取消加工', exact: true })
      .boundingBox())!
    expect(cancelBox.x).toBeGreaterThanOrEqual(0)
    expect(cancelBox.x + cancelBox.width).toBeLessThanOrEqual(390)
    await page.screenshot({
      path: test.info().outputPath('media-pending-narrow.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '取消加工', exact: true }).click()
    await expect(tools).toBeEnabled()
    await expect(tools).toBeFocused()
    await expect.poll(() => failed).toBe(true)
    held.release()
    await expect.poll(held.finished).toBe(true)
    await page.unroute('**/api/media/derive')
    await start(page)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
        ),
      )
      .toBe(2)
    await page.keyboard.press('ControlOrMeta+z')
    expect(
      await page.evaluate(() =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.kind === 'image')
          .map((el) => el.id),
      ),
    ).toEqual([f.source])
    await page.keyboard.press('ControlOrMeta+Shift+z')
    expect(
      await page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    ).toBe(2)
  } finally {
    held.release()
  }
})
test('加工失败后保留裁剪参数，再次打开可修改并成功重试', async ({ page }) => {
  await fixture(page)
  await page.route(
    '**/api/media/derive',
    async (route) => {
      await route.fulfill({ status: 500, json: { message: '测试加工暂时失败' } })
    },
    { times: 1 },
  )
  await start(page)
  await expect(page.locator('.ui-toast')).toContainText('测试加工暂时失败')
  await page.getByRole('button', { name: '媒体工具', exact: true }).click()
  const tools = page.getByRole('dialog', { name: '媒体工具', exact: true })
  await expect(tools.getByLabel('宽', { exact: true })).toHaveValue('80')
  await tools.getByLabel('宽', { exact: true }).fill('64')
  await tools.getByRole('button', { name: '开始加工', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    )
    .toBe(2)
  const selected = await page.evaluate(() =>
    window.__plein.engine.doc.get(window.__plein.engine.selection.values()[0]!),
  )
  const meta = await (await page.request.get(`/api/assets/${selected!.assetId}/meta`)).json()
  expect(meta).toMatchObject({ width: 64, height: 90 })
})

test('批量加工取消后保留已完成的素材，不写入后续结果或接管原选区', async ({ page }) => {
  const f = await fixture(page)
  const second = await page.evaluate(({ asset, source }) => {
    const e = window.__plein.engine as typeof window.__plein.engine & { paste(data: unknown): void }
    e.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'second',
          kind: 'image',
          name: '加工原图二',
          assetId: asset,
          x: 300,
          y: 600,
          w: 240,
          h: 135,
          parentId: null,
        },
      ],
    })
    const second = [...e.doc.elements()].find((el) => el.name === '加工原图二')!.id
    e.selection.set([source, second])
    return second
  }, f)
  await zoomTo(page, [f.source, second])
  let submitted = 0,
    ready = false,
    release!: () => void
  const waiting = new Promise<void>((r) => {
    release = r
  })
  await page.route('**/api/media/derive', async (route) => {
    submitted++
    const response = await route.fetch()
    if (submitted === 2) {
      ready = true
      await waiting
    }
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.getByRole('button', { name: '批量加工', exact: true }).click()
    await page
      .getByRole('dialog', { name: '批量加工', exact: true })
      .getByRole('button', { name: '旋转 90°', exact: true })
      .click()
    await expect.poll(() => ready).toBe(true)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
        ),
      )
      .toBe(3)
    expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([
      f.source,
      second,
    ])
    await page.getByRole('button', { name: '取消加工', exact: true }).click()
    await expect(page.locator('.ui-toast')).toContainText('已取消加工，已完成 1 个素材')
    release()
    await expect(page.getByRole('button', { name: '批量加工', exact: true })).toBeEnabled()
    expect(
      await page.evaluate(
        () => [...window.__plein.engine.doc.elements()].filter((el) => el.kind === 'image').length,
      ),
    ).toBe(3)
    expect(submitted).toBe(2)
    await page.keyboard.press('ControlOrMeta+z')
    expect(
      await page.evaluate(() =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.kind === 'image')
          .map((el) => el.id)
          .sort(),
      ),
    ).toEqual([f.source, second].sort())
  } finally {
    release()
  }
})
