import { expect, test } from './fixtures'
import { newProject } from './canvas'
import { solidPng } from '../packages/providers/src/mock/media'
import { openCanvasSettings } from './settings-ui'

test('矮窗口设置导航可滚动，最后一个分区和关闭入口保持可达', async ({ page }) => {
  await newProject(page)
  const settings = await openCanvasSettings(page)
  await page.setViewportSize({ width: 1000, height: 240 })
  const nav = settings.getByRole('navigation', { name: '设置分区', exact: true })
  const last = nav.getByRole('button').last()
  await last.scrollIntoViewIfNeeded()
  await last.click()
  await expect(last).toHaveAttribute('aria-current', 'page')
  const visible = await last.boundingBox()
  const bounds = await settings.boundingBox()
  expect(visible!.y).toBeGreaterThanOrEqual(bounds!.y)
  expect(visible!.y + visible!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
  expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(settings.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  await settings.screenshot({ path: test.info().outputPath('settings-short-window.png') })
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
})

test('窄窗口下拉完整展示长名称，不越界且取消后恢复焦点', async ({ page }) => {
  const name = '平台专属音色与模型配置的完整名称_' + 'LongIdentifier'.repeat(6)
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch()
    const catalog = await response.json()
    const provider = catalog.providers.find((p: { id: string }) => p.id === 'plein/mock')
    provider.settingsSchema.properties.failWith = {
      type: 'string',
      title: '长名称验收',
      enum: ['none', 'auth'],
      labels: { none: name, auth: '第二项' },
      default: 'none',
    }
    await route.fulfill({ response, json: catalog })
  })
  await newProject(page)
  const settings = await openCanvasSettings(page)
  await page.setViewportSize({ width: 390, height: 700 })
  await settings.getByRole('button', { name: /^模型平台/ }).click()
  const row = settings.locator('[data-provider="plein/mock"]')
  await row.getByRole('button', { expanded: false }).click()
  const field = row.getByRole('combobox', { name: '长名称验收', exact: true })
  await expect(field).toHaveText(name)
  await field.click()
  const option = page.getByRole('option', { name, exact: true })
  await expect(option).toBeVisible()
  const bounds = await option.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(8)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(382)
  expect(await option.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const text = option.getByText(name, { exact: true })
  expect(
    await text.evaluate(
      (el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1,
    ),
  ).toBe(true)
  await page.screenshot({ path: test.info().outputPath('select-long-name.png') })
  await page.keyboard.press('Escape')
  await expect(field).toBeFocused()
  await expect(settings).toBeVisible()
})

test('上下空间都不足时，提示气泡仍留在窗口内', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('plein.welcome', '1'))
  await page.goto('/')
  await page.setViewportSize({ width: 1000, height: 220 })
  const button = page.getByRole('button', { name: '设置', exact: true })
  await button.evaluate((el) => {
    el.style.position = 'fixed'
    el.style.left = '20px'
    el.style.top = '100px'
    el.setAttribute('title', '这是一段较长的操作说明。'.repeat(12))
  })
  await button.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toBeVisible()
  const bounds = await tip.boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(8)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(212)
})

test('短窗口的长项目名确认框可滚动查看，取消不会删除项目', async ({ page }) => {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const title = '长项目名称_' + 'A'.repeat(100)
  expect(
    (await page.request.patch(`/api/projects/${canvas.projectId}`, { data: { title } })).ok(),
  ).toBe(true)
  await page.goto('/')
  await page.setViewportSize({ width: 390, height: 240 })
  await page
    .locator(`[data-project="${canvas.projectId}"]`)
    .getByRole('button', { name: '删除', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: /^删除项目/ })
  await expect(dialog).toBeVisible()
  await dialog.evaluate(async (el) =>
    Promise.allSettled(el.getAnimations().map((animation) => animation.finished)),
  )
  const bounds = await dialog.boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(16)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(224)
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const heading = dialog.getByRole('heading')
  await heading.scrollIntoViewIfNeeded()
  await expect(heading).toBeInViewport()
  const cancel = dialog.getByRole('button', { name: '取消', exact: true })
  await cancel.scrollIntoViewIfNeeded()
  await expect(cancel).toBeInViewport()
  await cancel.click()
  await expect(dialog).toHaveCount(0)
  expect((await page.request.get(`/api/projects/${canvas.projectId}`)).ok()).toBe(true)
})

test('窄窗口素材预览显示完整长标题，关闭按钮不被挤出', async ({ page }) => {
  await newProject(page)
  const name = '这是用于检查面板标题换行和关闭入口对齐的素材_' + 'LongName'.repeat(8) + '.png'
  const uploaded = await page.request.post('/api/assets', {
    headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name) },
    data: Buffer.from(solidPng(160, 96, [60, 100, 140])),
  })
  expect(uploaded.status()).toBe(201)
  await page.getByRole('button', { name: '素材', exact: true }).click()
  const library = page.getByRole('dialog', { name: '素材', exact: true })
  await library.getByRole('combobox', { name: '关联项目', exact: true }).click()
  await page.getByRole('option', { name: '全部项目', exact: true }).click()
  await library.getByRole('button', { name: `查看素材 ${name}`, exact: true }).click()
  await library.getByRole('button', { name: '放大查看素材', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 700 })
  const preview = page.getByRole('dialog', { name: '素材预览', exact: true })
  const heading = preview.getByRole('heading', { name, exact: true })
  await expect(heading).toBeVisible()
  expect((await heading.boundingBox())!.width).toBeGreaterThan(
    (await preview.boundingBox())!.width * 0.7,
  )
  expect(
    await heading.evaluate(
      (el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
    ),
  ).toBe(true)
  await expect(preview.getByRole('button', { name: '关闭', exact: true })).toBeInViewport()
  await preview.screenshot({ path: test.info().outputPath('preview-long-title.png') })
  await preview.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(library).toBeVisible()
})
