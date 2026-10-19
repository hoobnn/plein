import { openLibraryPanel } from './library-ui'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

let dir = ''
test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plein-library-preview-'))
  for (let i = 0; i < 2; i++)
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${i ? 'orange' : 'teal'}:s=64x64`,
      '-frames:v',
      '1',
      join(dir, `reference-${i}.png`),
    ])
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=64x64:d=0.4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(dir, 'reference.mp4'),
  ])
})
test.afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function asset(page: Page, file: string) {
  const response = await page.request.post('/api/assets', {
    headers: {
      'content-type': file.endsWith('.mp4') ? 'video/mp4' : 'image/png',
      'x-file-name': file,
    },
    data: readFileSync(join(dir, file)),
  })
  expect(response.status()).toBe(201)
  return (await response.json()).id as string
}
async function openItem(page: Page, label: string, name: string) {
  const panel = await openLibraryPanel(page)
  await panel
    .getByRole('group', { name: '资产类别' })
    .getByRole('button', { name: label, exact: true })
    .click()
  await panel
    .getByRole('group', { name: '范围', exact: true })
    .getByRole('button', { name: label === '特效' ? '我的' : '全部', exact: true })
    .click()
  await panel.getByRole('listitem').filter({ hasText: name }).getByRole('button').first().click()
  return panel
}

for (const kind of ['scene', 'character'] as const) {
  test(`${kind} 大图下方参考条失败可独立重试，键盘固定预览且保存状态不变`, async ({ page }) => {
    await newProject(page)
    await page.setViewportSize({ width: kind === 'scene' ? 800 : 390, height: 700 })
    const base = await asset(page, 'reference-0.png')
    const second = await asset(page, 'reference-1.png')
    const labels = kind === 'scene' ? ['主场景图', '多角度'] : ['全身定妆图', '肖像／半身图']
    const original = [
      { slot: kind === 'scene' ? 'main' : 'full_body', assetId: base },
      { slot: kind === 'scene' ? 'angle' : 'portrait', assetId: second },
    ]
    const name = `${kind} 参考条恢复`
    const created = await page.request.post('/api/library', {
      data: { kind, name, images: original },
    })
    expect(created.status()).toBe(201)
    const item = await created.json()
    let fail = true
    let requests = 0
    await page.route(`**/api/assets/${second}/thumb-256`, (route) => {
      requests++
      return fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()
    })
    const panel = await openItem(page, kind === 'scene' ? '场景' : '角色', name)
    const strip = panel.getByRole('list', { name: '参考图', exact: true })
    const first = strip.getByRole('button', { name: labels[0], exact: true })
    const select = strip.getByRole('button', { name: labels[1], exact: true })
    const retry = strip.getByRole('button', { name: `重新加载${labels[1]}`, exact: true })
    await expect(retry).toBeVisible()
    const shown = () => panel.locator('.lib-hero img').last()
    await expect(shown()).toHaveAttribute('src', new RegExp(base))
    const beforeRetry = requests
    await retry.click()
    await expect.poll(() => requests).toBeGreaterThan(beforeRetry)
    await expect(retry).toBeVisible()
    await expect(select).toBeFocused()
    await expect(shown()).toHaveAttribute('src', new RegExp(base))
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(retry).toBeVisible()
    await expect(shown()).toHaveAttribute('src', new RegExp(base))
    await select.focus()
    await page.keyboard.press('Enter')
    await expect(shown()).toHaveAttribute('src', new RegExp(second))
    await first.hover()
    await expect(shown()).toHaveAttribute('src', new RegExp(base))
    await page.mouse.move(5, 5)
    await expect(shown()).toHaveAttribute('src', new RegExp(second))
    await retry.scrollIntoViewIfNeeded()
    await panel.screenshot({
      path: test.info().outputPath(`${kind}-strip-failed.png`),
      animations: 'disabled',
    })
    await first.focus()
    await page.keyboard.press('Enter')
    await expect(shown()).toHaveAttribute('src', new RegExp(base))
    fail = false
    if (kind === 'scene') await retry.click()
    else {
      await retry.focus()
      await page.keyboard.press('Enter')
    }
    await expect(retry).toHaveCount(0)
    await expect(select).toBeFocused()
    await expect(select).toHaveAttribute('aria-pressed', 'false')
    await expect
      .poll(() =>
        select
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    await expect(shown()).toHaveAttribute('src', new RegExp(base))
    await page.mouse.move(5, 5)
    await select.focus()
    await page.keyboard.press('Enter')
    await expect(shown()).toHaveAttribute('src', new RegExp(second))
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
    expect((await (await page.request.get(`/api/library/${item.id}`)).json()).images).toEqual(
      original,
    )
    await panel.screenshot({
      path: test.info().outputPath(`${kind}-strip-recovered.png`),
      animations: 'disabled',
    })
  })
}

test('场景缩略图失败可反复重试，不改素材列表或已保存状态', async ({ page }) => {
  await newProject(page)
  const id = await asset(page, 'reference-0.png')
  const created = await page.request.post('/api/library', {
    data: { kind: 'scene', name: '场景缩略图恢复', images: [{ slot: 'main', assetId: id }] },
  })
  const item = await created.json()
  let fail = true
  await page.route(`**/api/assets/${id}/thumb-256`, (route) =>
    fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue(),
  )
  const panel = await openItem(page, '场景', '场景缩略图恢复')
  const field = panel
    .locator('.ui-field')
    .filter({ has: page.locator('.ui-label').filter({ hasText: '主场景图' }) })
    .last()
  const retry = field.getByRole('button', { name: '重新加载主场景图 1', exact: true })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect(retry).toBeVisible()
  await expect(field.getByRole('button', { name: '移除', exact: true })).toBeEnabled()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  fail = false
  await retry.click()
  await expect
    .poll(() =>
      field
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
  await expect(retry).toHaveCount(0)
  expect((await (await page.request.get(`/api/library/${item.id}`)).json()).images).toEqual([
    { slot: 'main', assetId: id },
  ])
})

test('特效参考视频失败可重载，恢复后实际播放，移除与保存仍可用', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const id = await asset(page, 'reference.mp4')
  const created = await page.request.post('/api/library', {
    data: { kind: 'effect', name: '特效视频预览恢复', video: id },
  })
  const item = await created.json()
  let fail = true
  await page.route(`**/api/assets/${id}`, (route) =>
    fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue(),
  )
  const panel = await openItem(page, '特效', '特效视频预览恢复')
  const field = panel
    .locator('.ui-field')
    .filter({ has: page.locator('.ui-label').filter({ hasText: '参考视频' }) })
    .last()
  await expect(field.getByRole('alert')).toContainText('视频加载失败')
  const retry = field.getByRole('button', { name: '重新加载参考视频', exact: true })
  await retry.click()
  await expect(field.getByRole('alert')).toBeVisible()
  await field.scrollIntoViewIfNeeded()
  await panel.screenshot({
    path: test.info().outputPath('library-video-failed.png'),
    animations: 'disabled',
  })
  fail = false
  await retry.click()
  await expect
    .poll(() =>
      field
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.readyState >= 2 && video.videoWidth > 0),
    )
    .toBe(true)
  await field.locator('video').evaluate(async (video: HTMLVideoElement) => {
    await video.play()
  })
  await expect
    .poll(() => field.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(0)
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  await field.getByRole('button', { name: '移除', exact: true }).click()
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect((await (await page.request.get(`/api/library/${item.id}`)).json()).video).toBeNull()
})

test('角色补充参考重试与预览分离，小图恢复不改分类或保存状态', async ({ page }) => {
  await newProject(page)
  const id = await asset(page, 'reference-0.png')
  const created = await page.request.post('/api/library', {
    data: { kind: 'character', name: '补充参考恢复', images: [{ slot: 'extra', assetId: id }] },
  })
  const item = await created.json()
  let fail = true
  await page.route(`**/api/assets/${id}/thumb-256`, (route) =>
    fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue(),
  )
  const panel = await openItem(page, '角色', '补充参考恢复')
  const extras = panel.locator('.lib-character-extra-list')
  const preview = extras.getByRole('button', { name: '预览其他参考 1', exact: true })
  await preview.scrollIntoViewIfNeeded()
  const retry = extras.getByRole('button', { name: '重新加载预览其他参考 1', exact: true })
  await expect(retry).toBeVisible()
  await panel.screenshot({
    path: test.info().outputPath('extra-reference-failed.png'),
    animations: 'disabled',
  })
  await preview.click()
  await expect(panel.locator('.lib-hero-caption')).toContainText('其他参考')
  fail = false
  await retry.click()
  await expect
    .poll(() =>
      extras
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true)
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  expect((await (await page.request.get(`/api/library/${item.id}`)).json()).images).toEqual([
    { slot: 'extra', assetId: id },
  ])
})

for (const media of ['image', 'video'] as const) {
  test(`画布${media}候选缩略图可独立重试，仍可选择且清除旧上传错误`, async ({ page }) => {
    await newProject(page)
    const filename = media === 'image' ? 'reference-0.png' : 'reference.mp4'
    const label = media === 'image' ? '场景' : '特效'
    const name = `画布${media}候选恢复`
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await chooser).setFiles(join(dir, filename))
    await expect
      .poll(() =>
        page.evaluate(
          (kind) =>
            [...window.__plein.engine.doc.elements()].filter((el) => el.kind === kind).length,
          media,
        ),
      )
      .toBe(1)
    await page.keyboard.press('Escape')
    const id = await asset(page, filename)
    await page.request.post('/api/library', {
      data: { kind: media === 'image' ? 'scene' : 'effect', name },
    })
    let fail = true
    await page.route(
      `**/api/assets/${id}/${media === 'image' ? 'thumb-256' : 'poster'}`,
      (route) => (fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue()),
    )
    const panel = await openItem(page, label, name)
    const field = panel
      .locator('.ui-field')
      .filter({
        has: page
          .locator('.ui-label')
          .filter({ hasText: media === 'image' ? '主场景图' : '参考视频' }),
      })
      .last()
    await page.route(
      '**/api/assets',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: '改用画布素材' }),
        }),
      { times: 1 },
    )
    const upload = page.waitForEvent('filechooser')
    await field
      .getByRole('button', { name: media === 'image' ? '上传' : '上传视频', exact: true })
      .click()
    await (await upload).setFiles(join(dir, filename))
    await expect(field.getByText('改用画布素材', { exact: true })).toBeVisible()
    await field.getByRole('button', { name: '从画布选', exact: true }).click()
    const picker = page.locator('.ui-menu[aria-label="从画布选"]')
    const retry = picker.getByRole('button', { name: /^重新加载选择/ })
    const select = picker.getByRole('button', { name: /^选择/ })
    await expect(retry).toBeVisible()
    await expect(select).toBeEnabled()
    await retry.click()
    await expect(retry).toBeVisible()
    await expect(picker).toBeVisible()
    fail = false
    await retry.click()
    await expect
      .poll(() =>
        picker
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true)
    await expect(picker).toBeVisible()
    await select.click()
    await expect(picker).toBeHidden()
    await expect(field.getByText('改用画布素材', { exact: true })).toHaveCount(0)
    await expect(field.locator(media === 'image' ? 'img' : 'video')).toHaveAttribute(
      'src',
      new RegExp(id),
    )
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  })
}
