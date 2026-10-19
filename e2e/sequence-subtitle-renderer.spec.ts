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
  source: { script?: string; secondShot?: boolean } = {},
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
    shots: [
      { shotId: 'one', duration: 6, dialogue: [], subtitle: source.script },
      ...(source.secondShot ? [{ shotId: 'two', duration: 4, dialogue: [] }] : []),
    ],
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

test('暂停时修改字幕立即重绘，隐藏、清空与撤销重做不残留旧字形', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await setup(page)
  const stage = f.editor.locator('.seq-stage')
  await expect(stage).toHaveAttribute('data-subtitles', 'libass')
  const pixels = async () => lit(page, await stage.screenshot({ animations: 'disabled' }))
  await expect.poll(pixels).toBeGreaterThan(50)
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  const text = f.editor.getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true })
  await text.fill('Changed subtitle with a longer sentence')
  await expect.poll(pixels).toBeGreaterThan(100)
  const visible = f.editor.getByRole('checkbox', { name: '显示字幕 1', exact: true })
  await visible.uncheck()
  await expect.poll(pixels).toBeLessThan(10)
  await visible.check()
  await expect.poll(pixels).toBeGreaterThan(100)
  await text.fill('')
  await expect.poll(pixels).toBeLessThan(10)
  await expect(f.editor.getByRole('button', { name: '导出样片 MP4', exact: true })).toBeDisabled()
  const home = f.editor.getByRole('button', { name: '回到开头', exact: true })
  await home.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(text).toHaveValue('Changed subtitle with a longer sentence')
  await expect.poll(pixels).toBeGreaterThan(100)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(text).toHaveValue('')
  await expect.poll(pixels).toBeLessThan(10)
  await text.fill('Restored subtitle')
  await visible.focus()
  await page.keyboard.press('Space')
  await expect(visible).not.toBeChecked()
  await page.keyboard.press('Space')
  await expect(visible).toBeChecked()
  await home.focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(visible).not.toBeChecked()
  await expect(text).toHaveValue('Restored subtitle')
  await expect.poll(pixels).toBeLessThan(10)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(visible).toBeChecked()
  await expect(text).toHaveValue('Restored subtitle')
  await expect.poll(pixels).toBeGreaterThan(50)
  expect(errors).toEqual([])
})

test('字幕时间边界与空文本指出具体字段，隐藏后解除导出限制', async ({ page }) => {
  const f = await setup(page)
  await expect(f.editor.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'libass')
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  const text = f.editor.getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true })
  const start = f.editor.getByRole('spinbutton', { name: '镜头 1 字幕 1 开始（秒）', exact: true })
  const end = f.editor.getByRole('spinbutton', { name: '镜头 1 字幕 1 结束（秒）', exact: true })
  const output = f.editor.getByRole('button', { name: '导出样片 MP4', exact: true })
  await text.fill('   ')
  await expect(text).toHaveAttribute('aria-invalid', 'true')
  await expect(text).toHaveAccessibleDescription('请输入字幕文本，或关闭这句字幕的显示。')
  await expect(output).toBeDisabled()
  await f.editor
    .getByText('请输入字幕文本，或关闭这句字幕的显示。', { exact: true })
    .scrollIntoViewIfNeeded()
  await f.editor.screenshot({ path: test.info().outputPath('subtitle-empty-validation.png') })
  await text.fill('Fixed subtitle')
  await start.fill('1')
  await expect(end).toHaveAttribute('aria-invalid', 'true')
  await expect(end).toHaveAccessibleDescription('结束时间需要晚于开始时间。')
  await expect(output).toBeDisabled()
  await end.fill('2')
  await expect(end).not.toHaveAttribute('aria-invalid', 'true')
  await expect(output).toBeEnabled()
  const stage = f.editor.locator('.seq-stage')
  const pixels = async () => lit(page, await stage.screenshot())
  await expect.poll(pixels).toBeLessThan(10)
  await f.editor.getByRole('button', { name: '回到开头', exact: true }).click()
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(pixels).toBeGreaterThan(50)
  await end.fill('1')
  await expect.poll(pixels).toBeLessThan(10)
  await f.editor.getByText('结束时间需要晚于开始时间。', { exact: true }).scrollIntoViewIfNeeded()
  await f.editor.screenshot({ path: test.info().outputPath('subtitle-time-validation.png') })
  await end.fill('2')
  await expect.poll(pixels).toBeGreaterThan(50)
  await text.fill('')
  await f.editor.getByRole('checkbox', { name: '显示字幕 1', exact: true }).uncheck()
  await expect(text).not.toHaveAttribute('aria-invalid', 'true')
  await expect(output).toBeEnabled()
})

test('连续新增字幕与修改可逐步撤销，重做保持独立条目', async ({ page }) => {
  const f = await setup(page)
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  const fields = f.editor.getByRole('textbox', { name: /镜头 1 字幕 \d+ 文本/ })
  const add = f.editor.getByRole('button', { name: '新增字幕', exact: true })
  await add.click()
  await add.click()
  await expect(fields).toHaveCount(4)
  await fields.nth(3).fill('New independent subtitle')
  await f.editor.getByRole('button', { name: '回到开头', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(fields.nth(3)).toHaveValue('新字幕')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(fields).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(fields).toHaveCount(2)
  await expect(fields.first()).toHaveValue('Subtitle ready')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(fields).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(fields).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(fields.nth(3)).toHaveValue('New independent subtitle')
})

test('按台词重建字幕可独立撤销并完整恢复手改轨道', async ({ page }) => {
  const f = await setup(page, {}, { script: 'Automatic script subtitle' })
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  const fields = f.editor.getByRole('textbox', { name: /镜头 1 字幕 \d+ 文本/ })
  const original = await page.evaluate(
    (id) => window.__plein.engine.doc.get(id)!.params!.subtitleTrack,
    f.id,
  )
  await f.editor
    .getByRole('button', { name: '按当前台词重建字幕（替换手改）', exact: true })
    .click()
  await expect(fields).toHaveCount(1)
  await expect(fields.first()).toHaveValue('Automatic script subtitle')
  await f.editor.getByRole('button', { name: '回到开头', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(fields).toHaveCount(2)
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)!.params!.subtitleTrack, f.id),
  ).toEqual(original)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(fields).toHaveCount(1)
  await expect(fields.first()).toHaveValue('Automatic script subtitle')
  const stage = f.editor.locator('.seq-stage')
  await expect(stage).toHaveAttribute('data-subtitles', 'libass')
  await expect.poll(async () => lit(page, await stage.screenshot())).toBeGreaterThan(50)
})

test('只读序列可预览，字幕编辑控件明确不可写且没有异常', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const f = await setup(page, {}, { secondShot: true })
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(f.editor).toHaveCount(0)
  await page.evaluate(() => {
    const doc = window.__plein.engine.doc as typeof window.__plein.engine.doc & {
      readOnly: boolean
    }
    doc.readOnly = true
  })
  const editor = await f.open()
  await expect(editor.locator('.seq-stage')).toHaveAttribute('data-subtitles', 'libass')
  await editor.getByRole('button', { name: '字幕', exact: true }).click()
  await expect(
    editor.getByRole('textbox', { name: '镜头 1 字幕 1 文本', exact: true }),
  ).toBeDisabled()
  await expect(editor.getByRole('checkbox', { name: '显示字幕 1', exact: true })).toBeDisabled()
  await expect(editor.getByRole('button', { name: '新增字幕', exact: true }).first()).toBeDisabled()
  await expect(
    editor.getByRole('button', { name: '按当前台词重建字幕（替换手改）', exact: true }),
  ).toBeDisabled()
  await expect(
    editor.getByText('当前画布为只读，仍可预览，暂不能修改或生成新成片。', { exact: true }),
  ).toBeVisible()
  await expect(editor.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  await expect(editor.getByRole('button', { name: '导出样片 MP4', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: '成片', exact: true }).click()
  await expect(editor.getByRole('switch', { name: '开启字幕', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: '镜头', exact: true }).click()
  await expect(
    editor.getByRole('spinbutton', { name: '样片镜头时长（秒）', exact: true }),
  ).toBeDisabled()
  const clips = editor.locator('.seq-clip')
  const a = (await clips.nth(0).boundingBox())!
  const b = (await clips.nth(1).boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 10, b.y + b.height / 2, { steps: 6 })
  await page.mouse.up()
  await clips.nth(1).click()
  await expect(editor.locator('.seq-time')).toContainText('0:06.0')
  await editor.getByRole('button', { name: '播放', exact: true }).click()
  await expect(editor.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
  await editor.getByRole('button', { name: '暂停', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 700 })
  await expect(editor.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await editor.screenshot({ path: test.info().outputPath('sequence-readonly-390.png') })
  expect(await page.evaluate(() => [...window.__plein.engine.doc.elements()])).toEqual(f.original)
  expect(errors).toEqual([])
})

test('字幕时间清空和无效数字保留草稿，失焦恢复且不篡改已保存时间', async ({ page }) => {
  const f = await setup(page)
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  const end = f.editor.getByRole('spinbutton', { name: '镜头 1 字幕 1 结束（秒）', exact: true })
  const saved = () =>
    page.evaluate((id) => {
      const track = window.__plein.engine.doc.get(id)!.params!.subtitleTrack as {
        cues: Array<{ end: number }>
      }
      return track.cues[0]!.end
    }, f.id)
  for (const value of ['', '-1']) {
    await end.fill(value)
    await expect(end).toHaveValue(value)
    await expect(end).toHaveAttribute('aria-invalid', 'true')
    await expect(end).toHaveAccessibleDescription(
      '请输入大于或等于 0 的有效时间；失焦后恢复已保存值。',
    )
    expect(await saved()).toBe(1)
    if (value === '-1') {
      await f.editor
        .getByText('请输入大于或等于 0 的有效时间；失焦后恢复已保存值。', { exact: true })
        .scrollIntoViewIfNeeded()
      await f.editor.screenshot({ path: test.info().outputPath('subtitle-time-draft.png') })
    }
    await end.blur()
    await expect(end).toHaveValue('1')
  }
  await end.fill('')
  await end.pressSequentially('1.25')
  await expect(end).toHaveValue('1.25')
  expect(await saved()).toBe(1.25)
  await end.blur()
  await f.editor.getByRole('button', { name: '回到开头', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(end).toHaveValue('1')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(end).toHaveValue('1.25')
  await f.editor.getByRole('button', { name: '关闭', exact: true }).click()
  await f.open()
  await f.editor.getByRole('button', { name: '字幕', exact: true }).click()
  await expect(end).toHaveValue('1.25')
})
