import { expect, type Locator, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, revealGenerator, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
async function source(page: Page, metadataFailure = false) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  const upload = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png' },
    data: Buffer.from(solidPng(160, 96, [100, 140, 180])),
  })
  expect(upload.status()).toBe(201)
  const assetId = (await upload.json()).id as string
  let failMeta = metadataFailure
  if (metadataFailure)
    await page.route(`**/api/assets/${assetId}/meta`, (route) =>
      failMeta
        ? route.fulfill({ status: 503, json: { message: '元信息暂不可用' } })
        : route.continue(),
    )
  const id = await page.evaluate((assetId) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'source',
          kind: 'image',
          name: '加载原图',
          assetId,
          x: 400,
          y: 300,
          w: 240,
          h: 144,
          z: 'a0',
          rotation: 0,
          locked: false,
          parentId: null,
        },
      ],
    })
    const id = [...engine.doc.elements()][0]!.id
    engine.selection.set([id])
    return id
  }, assetId)
  await zoomTo(page, [id])
  const dialog = page.getByRole('dialog', { name: '画重绘区域', exact: true })
  return {
    assetId,
    id,
    dialog,
    errors,
    recoverMeta: () => {
      failMeta = false
    },
  }
}
async function draw(page: Page, dialog: Locator, start = 0.2, end = 0.5) {
  const canvas = dialog.getByTestId('mask-canvas')
  await expect(canvas).toBeVisible()
  await dialog.getByRole('button', { name: '框选', exact: true }).click()
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * start, box.y + box.height * 0.25)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * end, box.y + box.height * 0.65, { steps: 4 })
  await page.mouse.up()
}
for (const mode of ['source', 'corrupt', 'mask', 'metadata'] as const) {
  test(`重绘 ${mode} 读取失败阻止绘制，重新加载后可实际保存`, async ({ page }, testInfo) => {
    if (mode === 'source') await page.setViewportSize({ width: 390, height: 800 })
    const f = await source(page, mode === 'metadata')
    let target = f.assetId
    let prior: unknown = null
    if (mode === 'mask') {
      await page.getByRole('button', { name: '局部重绘', exact: true }).click()
      await draw(page, f.dialog)
      await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
      await expect(f.dialog).toHaveCount(0)
      prior = await page.evaluate(
        () =>
          [...window.__plein.engine.doc.elements()].find(
            (el) => el.nodeType === 'plein/image-edit',
          )!.params!.mask,
      )
      target = (prior as { assetId: string }).assetId
    }
    let failing = true
    if (mode !== 'metadata')
      await page.route(`**/api/assets/${target}`, (route) =>
        !failing
          ? route.continue()
          : mode === 'corrupt'
            ? route.fulfill({ status: 200, contentType: 'image/png', body: 'not a PNG' })
            : route.fulfill({ status: 503, body: '读取暂不可用' }),
      )
    if (mode === 'mask') {
      // 编辑器固定在卡片下方，控件可能在窗口外：先把它移进窗口
      const redraw = page
        .getByTestId('mask-field')
        .getByRole('button', { name: '重画区域', exact: true })
        .last()
      await revealGenerator(page, redraw)
      await redraw.click()
    } else await page.getByRole('button', { name: '局部重绘', exact: true }).click()
    const alert = f.dialog.getByRole('alert')
    await expect(alert).toContainText(
      mode === 'mask'
        ? '已有重绘区域加载失败'
        : mode === 'metadata'
          ? '原图信息读取失败'
          : '原图加载失败',
    )
    await expect(f.dialog.getByTestId('mask-canvas')).toHaveCount(0)
    for (const name of ['框选', '画笔', '橡皮', '撤销', '重做', '清空', '完成'])
      await expect(f.dialog.getByRole('button', { name, exact: true })).toBeDisabled()
    await page.keyboard.press('ControlOrMeta+z')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(
      mode === 'mask' ? 2 : 1,
    )
    if (prior)
      expect(
        await page.evaluate(
          () =>
            [...window.__plein.engine.doc.elements()].find(
              (el) => el.nodeType === 'plein/image-edit',
            )!.params!.mask,
        ),
      ).toEqual(prior)
    await f.dialog.screenshot({ path: testInfo.outputPath('mask-load-error.png') })
    failing = false
    f.recoverMeta()
    await alert.getByRole('button', { name: '重新加载', exact: true }).click()
    await expect(f.dialog.getByTestId('mask-canvas')).toBeVisible()
    await expect(alert).toHaveCount(0)
    expect(
      await f.dialog.getByRole('img').evaluate((el: HTMLImageElement) => ({
        complete: el.complete,
        width: el.naturalWidth,
        height: el.naturalHeight,
      })),
    ).toEqual({ complete: true, width: 160, height: 96 })
    const alpha = await f.dialog
      .getByTestId('mask-canvas')
      .evaluate(
        (el: HTMLCanvasElement) =>
          el
            .getContext('2d')!
            .getImageData(Math.floor(el.width * 0.3), Math.floor(el.height * 0.4), 1, 1).data[3],
      )
    expect(alpha).toBe(mode === 'mask' ? 255 : 0)
    await draw(page, f.dialog, 0.6, 0.85)
    await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(f.dialog).toHaveCount(0)
    const nodes = await page.evaluate(() => [...window.__plein.engine.doc.elements()])
    expect(nodes).toHaveLength(2)
    expect(nodes.find((el) => el.nodeType === 'plein/image-edit')?.params?.mask).toMatchObject({
      sourceAssetId: f.assetId,
      width: 160,
      height: 96,
    })
    if (prior)
      expect(nodes.find((el) => el.nodeType === 'plein/image-edit')?.params?.mask).not.toEqual(
        prior,
      )
    expect(f.errors).toEqual([])
  })
}
test('原图加载等待中关闭不写入，重新打开可以绘制保存', async ({ page }) => {
  const f = await source(page)
  let held = false
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/api/assets/${f.assetId}`, async (route) => {
    const response = await route.fetch()
    held = true
    await waiting
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.getByRole('button', { name: '局部重绘', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    await expect(f.dialog.getByRole('status')).toContainText('正在加载重绘素材')
    await expect(f.dialog.getByTestId('mask-canvas')).toHaveCount(0)
    await expect(f.dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
    await f.dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.dialog).toHaveCount(0)
    release()
    await page.unrouteAll({ behavior: 'wait' })
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(1)
    await page.getByRole('button', { name: '局部重绘', exact: true }).click()
    await draw(page, f.dialog)
    await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect(f.dialog).toHaveCount(0)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(2)
    expect(f.errors).toEqual([])
  } finally {
    release()
  }
})
