import { expect, type Page, test } from '@playwright/test'
import { solidPng } from '../packages/providers/src/mock/media'
import { newProject, zoomTo } from './canvas'

type Engine = import('../packages/canvas-core/src/engine').Engine
async function fixture(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await newProject(page)
  const upload = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png' },
    data: Buffer.from(solidPng(160, 96, [100, 140, 180])),
  })
  expect(upload.status()).toBe(201)
  const assetId = (await upload.json()).id as string
  const id = await page.evaluate((assetId: string) => {
    const engine = window.__plein.engine as unknown as Engine
    engine.paste({
      plein: 1,
      edges: [],
      elements: [
        {
          id: 'mask-source',
          kind: 'image',
          name: '蒙版历史原图',
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
  await page.getByRole('button', { name: '局部重绘', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '画重绘区域', exact: true })
  const canvas = dialog.getByTestId('mask-canvas')
  await expect(canvas).toBeVisible()
  await dialog.getByRole('button', { name: '框选', exact: true }).click()
  const pixels = () =>
    canvas.evaluate(
      (el: HTMLCanvasElement) =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.toDataURL()))),
        ),
    )
  const draw = async (start: number, finish: number, release = true) => {
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width * start, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * finish, box.y + box.height * 0.65, { steps: 4 })
    if (release) await page.mouse.up()
  }
  const matches = async (expected: string) =>
    expect.poll(async () => (await pixels()) === expected).toBe(true)
  return { dialog, canvas, draw, pixels, matches, errors, id, assetId }
}
for (const width of [390]) {
  test(`蒙版 ${width}px 撤销重做与清空恢复不会改动画布`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    const f = await fixture(page)
    const blank = await f.pixels()
    await f.draw(0.1, 0.35)
    const first = await f.pixels()
    await f.draw(0.6, 0.85)
    const second = await f.pixels()
    await page.keyboard.press('ControlOrMeta+z')
    await f.matches(first)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await f.matches(second)
    await f.dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await f.matches(first)
    await f.dialog.getByRole('button', { name: '重做', exact: true }).click()
    await f.matches(second)
    await f.dialog.getByRole('button', { name: '清空', exact: true }).click()
    await f.matches(blank)
    await f.dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await f.matches(second)
    await page.keyboard.press('ControlOrMeta+z')
    await f.matches(first)
    await page.keyboard.press('ControlOrMeta+y')
    await f.matches(second)
    await page.keyboard.press('ControlOrMeta+z')
    await f.draw(0.4, 0.5)
    const branch = await f.pixels()
    expect(branch).not.toBe(first)
    await expect(f.dialog.getByRole('button', { name: '重做', exact: true })).toBeDisabled()
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await f.matches(branch)
    await f.dialog.screenshot({ path: testInfo.outputPath('mask-history.png') })
    expect(await f.dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    for (const name of ['撤销', '重做', '清空', '完成'])
      await expect(f.dialog.getByRole('button', { name, exact: true })).toBeInViewport()
    await f.dialog.getByRole('button', { name: '关闭', exact: true }).click()
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()].length)).toBe(1)
    expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.assetId, f.id)).toBe(
      f.assetId,
    )
    expect(f.errors).toEqual([])
  })
}
for (const composition of ['isComposing', 'legacy229'] as const) {
  test(`蒙版 ${composition} 输入法按键不撤销完成区域`, async ({ page }) => {
    const f = await fixture(page)
    await f.draw(0.1, 0.35)
    const first = await f.pixels()
    await f.dialog.getByRole('button', { name: '框选', exact: true }).dispatchEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      isComposing: composition === 'isComposing',
      keyCode: composition === 'legacy229' ? 229 : 90,
    })
    await f.matches(first)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(f.dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
    expect(f.errors).toEqual([])
  })
}
test('蒙版绘制中撤销先取消当前草稿，再撤销上一笔', async ({ page }) => {
  const f = await fixture(page)
  await f.draw(0.1, 0.35)
  const first = await f.pixels()
  await f.draw(0.6, 0.85, false)
  expect(await f.pixels()).not.toBe(first)
  await page.keyboard.press('ControlOrMeta+z')
  await page.mouse.up()
  await f.matches(first)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(f.dialog.getByRole('button', { name: '完成', exact: true })).toBeDisabled()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await f.matches(first)
  expect(f.errors).toEqual([])
})

test('蒙版重做与清空恢复后实际保存的 PNG 保留正确区域', async ({ page }) => {
  const f = await fixture(page)
  await f.draw(0.1, 0.35)
  await f.draw(0.6, 0.85)
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await f.dialog.getByRole('button', { name: '清空', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+z')
  const saved = await f.pixels()
  await f.draw(0.4, 0.5)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(f.dialog.getByRole('button', { name: '重做', exact: true })).toBeEnabled()
  let held = false
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    held = true
    await waiting
    await route.continue()
  })
  try {
    await f.dialog.getByRole('button', { name: '完成', exact: true }).click()
    await expect.poll(() => held).toBe(true)
    await expect(f.dialog.getByRole('button', { name: '重做', exact: true })).toBeDisabled()
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await page.keyboard.press('ControlOrMeta+y')
    await f.matches(saved)
  } finally {
    release()
  }
  await expect(f.dialog).toHaveCount(0)
  const mask = await page.evaluate(
    () =>
      [...window.__plein.engine.doc.elements()].find((el) => el.nodeType === 'plein/image-edit')
        ?.params?.mask as { assetId: string; sourceAssetId: string; width: number; height: number },
  )
  expect(mask).toMatchObject({ sourceAssetId: f.assetId, width: 160, height: 96 })
  const actual = await page.evaluate(async (assetId) => {
    const image = new Image()
    image.src = `/api/assets/${assetId}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data]
    return {
      width: canvas.width,
      height: canvas.height,
      first: at(32, 38),
      second: at(112, 38),
      outside: at(80, 80),
      future: at(72, 38),
    }
  }, mask.assetId)
  expect(actual).toEqual({
    width: 160,
    height: 96,
    first: [255, 255, 255, 255],
    second: [255, 255, 255, 255],
    outside: [0, 0, 0, 255],
    future: [0, 0, 0, 255],
  })
  await page
    .getByTestId('mask-field')
    .getByRole('button', { name: '重画区域', exact: true })
    .first()
    .click()
  await expect(f.canvas).toBeVisible()
  const loaded = await f.pixels()
  await f.dialog.getByRole('button', { name: '清空', exact: true }).click()
  expect(await f.pixels()).not.toBe(loaded)
  await f.dialog.getByRole('button', { name: '撤销', exact: true }).click()
  await f.matches(loaded)
  expect(f.errors).toEqual([])
})
