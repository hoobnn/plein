import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { centerOf, newProject, zoomTo } from './canvas'
import { animaticNode, arrangeAnimatic } from '../packages/nodes/src/animatic'
import { subtitleInputKey } from '../packages/nodes/src/sequence'

const font = readFileSync(
  new URL('../apps/web/node_modules/jassub/dist/default.woff2', import.meta.url),
)
async function setup(
  page: Page,
  fault: { info?: boolean; file?: boolean; gate?: Promise<void>; gateFileOnly?: boolean } = {},
) {
  await page.route('**/api/media/subtitle-font', async (route) => {
    if (!fault.gateFileOnly) await fault.gate
    return fault.info
      ? route.fulfill({ status: 503, json: { message: '字体信息暂不可用' } })
      : route.fulfill({ json: { family: 'Liberation Sans', version: 'subtitle-e2e' } })
  })
  await page.context().route('**/api/media/subtitle-font/file?*', async (route) => {
    await fault.gate
    return fault.file
      ? route.fulfill({ status: 503, body: 'font unavailable' })
      : route.fulfill({ contentType: 'font/woff2', body: font })
  })
  await newProject(page)
  const params = animaticNode.params.parse({
    subtitles: true,
    aspectRatio: '16:9',
    shots: [{ shotId: 'one', duration: 6, dialogue: [] }],
  })
  params.subtitleTrack = {
    inputKey: subtitleInputKey(params, arrangeAnimatic(params)),
    cues: [
      { id: 'a', source: 'one', start: 0, end: 1, text: 'Subtitle ready', hidden: false },
      { id: 'b', source: 'one', start: 3, end: 5, text: 'Later subtitle', hidden: false },
    ],
  }
  const id = await page.evaluate(
    (params) =>
      window.__plein.addNode({
        type: 'plein/animatic',
        name: '字幕渲染实测',
        x: 300,
        y: 200,
        params,
      }),
    params,
  )
  const open = async () => {
    await zoomTo(page, [id])
    const at = await centerOf(page, id)
    await page.mouse.dblclick(at.x, at.y)
    const editor = page.getByRole('dialog', { name: '序列', exact: true })
    await expect(editor).toBeVisible()
    return editor
  }
  return {
    id,
    open,
    editor: await open(),
    original: await page.evaluate(() => [...window.__plein.engine.doc.elements()]),
  }
}

async function lit(page: Page, image: Buffer) {
  return page.evaluate(async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`)
    const bitmap = await createImageBitmap(await response.blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data } = ctx.getImageData(
      Math.floor(canvas.width * 0.1),
      Math.floor(canvas.height * 0.65),
      Math.floor(canvas.width * 0.8),
      Math.floor(canvas.height * 0.3),
    )
    bitmap.close()
    let count = 0
    for (let i = 0; i < data.length; i += 4)
      if (data[i]! > 160 && data[i + 1]! > 160 && data[i + 2]! > 160) count++
    return count
  }, image.toString('base64'))
}

test('实际 libass 字幕按时间出现消失，关闭重开可继续渲染且不留 worker', async ({ page }) => {
  const warnings: string[] = [],
    errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[字幕预览]'))
      warnings.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await setup(page)
  const stage = f.editor.locator('.seq-stage')
  await expect(stage).toHaveAttribute('data-subtitles', 'libass')
  const pixels = async () => lit(page, await stage.screenshot({ animations: 'disabled' }))
  await expect.poll(pixels).toBeGreaterThan(50)
  await f.editor.getByRole('button', { name: '回到开头', exact: true }).click()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(pixels).toBeLessThan(10)
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(pixels).toBeGreaterThan(50)
  await stage.screenshot({
    path: test.info().outputPath('libass-subtitle.png'),
    animations: 'disabled',
  })
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toHaveCount(0)
  await expect.poll(() => page.workers().length).toBe(0)
  const again = await f.open()
  await expect(again.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'libass')
  await expect
    .poll(async () => lit(page, await again.locator('.seq-stage').screenshot()))
    .toBeGreaterThan(50)
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  expect(warnings).toEqual([])
  expect(errors).toEqual([])
})

for (const [kind, width] of [
  ['info', 320],
  ['file', 390],
] as const) {
  test(`${kind} 失败可原地重试，${width}px 下入口完整可用且重复失败不留 worker`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const fault: { info?: boolean; file?: boolean; gate?: Promise<void> } = { [kind]: true }
    const f = await setup(page, fault)
    await page.setViewportSize({ width, height: 700 })
    const stage = f.editor.locator('.seq-stage')
    const retry = f.editor.getByRole('button', { name: '重试字幕预览', exact: true })
    await expect(stage).toHaveAttribute('data-subtitles', 'fallback')
    await expect(retry).toBeInViewport()
    await f.editor.screenshot({ path: test.info().outputPath(`subtitle-fallback-${width}.png`) })
    await retry.click()
    await expect(stage).toHaveAttribute('data-subtitles', 'fallback')
    await expect.poll(() => page.workers().length).toBe(0)
    let release!: () => void
    fault.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await retry.click()
    await expect(stage).toHaveAttribute('data-subtitles', 'loading')
    await expect(retry).toHaveCount(0)
    await expect(stage.getByText('Subtitle ready', { exact: true })).toBeVisible()
    fault[kind] = false
    release()
    await expect(stage).toHaveAttribute('data-subtitles', 'libass')
    expect(await f.editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await f.editor.screenshot({ path: test.info().outputPath(`subtitle-retry-${width}.png`) })
    // 在标准宽度核对实际字形，避免窄屏缩放抗锯齿左右像素阈值。
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(async () => lit(page, await stage.screenshot())).toBeGreaterThan(50)
    await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(f.editor).toHaveCount(0)
    await expect.poll(() => page.workers().length).toBe(0)
    expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
    expect(errors).toEqual([])
  })
}

test('字体下载等待期间关闭，迟到结果不能创建 worker 或干扰重开', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let release!: () => void
  let requested!: () => void
  const request = new Promise<void>((resolve) => {
    requested = resolve
  })
  const fault: { gate?: Promise<void>; gateFileOnly: boolean } = { gateFileOnly: true }
  fault.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  page.on('request', (r) => {
    if (r.url().includes('/api/media/subtitle-font/file?')) requested()
  })
  const f = await setup(page, fault)
  await request
  await expect(f.editor.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'loading')
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toHaveCount(0)
  release()
  fault.gate = undefined
  await expect.poll(() => page.workers().length).toBe(0)
  const again = await f.open()
  await expect(again.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'libass')
  await expect
    .poll(async () => lit(page, await again.locator('.seq-stage').screenshot()))
    .toBeGreaterThan(50)
  expect(errors).toEqual([])
})

test('字体信息临时失败后重开可恢复真实字幕', async ({ page }) => {
  const fault = { info: true }
  const f = await setup(page, fault)
  await expect(f.editor.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'fallback')
  await expect(
    f.editor.locator('.seq-stage').getByText('Subtitle ready', { exact: true }),
  ).toBeVisible()
  fault.info = false
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toHaveCount(0)
  const again = await f.open()
  await expect(again.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'libass')
  await expect
    .poll(async () => lit(page, await again.locator('.seq-stage').screenshot()))
    .toBeGreaterThan(50)
})

test('字体文件失败显示近似字幕并释放 worker', async ({ page }) => {
  const f = await setup(page, { file: true })
  await expect(f.editor.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'fallback')
  await expect(
    f.editor.locator('.seq-stage').getByText('Subtitle ready', { exact: true }),
  ).toBeVisible()
  await expect.poll(() => page.workers().length).toBe(0)
})
