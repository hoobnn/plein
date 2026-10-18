import { expect, type Page, test } from '@playwright/test'
import { newProject, waitEngine } from './canvas'

test('删除库条目保留已有卡片与参考图，再存入时创建新关联', async ({ page }) => {
  const { panel, item, current, asset, canvas } = await fixture(page, { image: true })
  const node = (await current())!
  const before = await page.evaluate(() =>
    [...window.__plein.engine.doc.elements()].map((el) => ({ id: el.id, assetId: el.assetId })),
  )
  await panel.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: `删除道具「${item.name}」？`, exact: true })
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toBeHidden()
  expect(
    await page.evaluate(() =>
      [...window.__plein.engine.doc.elements()].map((el) => ({ id: el.id, assetId: el.assetId })),
    ),
  ).toEqual(before)
  expect((await page.request.get(`/api/assets/${asset}/meta`)).ok()).toBe(true)
  const generator = page.getByTestId('generator')
  await generator.getByRole('button', { name: '存入资产库', exact: true }).click()
  await expect(generator.getByRole('button', { name: '更新资产库', exact: true })).toBeVisible()
  const saved = (await (await page.request.get('/api/library')).json()).find(
    (entry: { projectId: string }) => entry.projectId === canvas.projectId,
  )
  expect(saved.id).not.toBe(item.id)
  expect(saved.images).toEqual([{ slot: 'main', assetId: asset }])
  expect(
    await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.libraryId, node.id),
  ).toBe(saved.id)
})

async function fixture(page: Page, options: { rename?: boolean; image?: boolean } = {}) {
  await newProject(page)
  const canvas = await (
    await page.request.get(`/api/canvases/${page.url().split('/').at(-1)}`)
  ).json()
  let asset: string | null = null
  if (options.image) {
    const upload = await page.request.post('/api/assets', {
      headers: { 'content-type': 'image/png', 'x-file-name': 'sync.png' },
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAYklEQVR4nO3PUQkAIBTAwBfFqDbXEH4cwmABbnP2+rrhgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACx67GbZ1HuLZqnQAAAAASUVORK5CYII=',
        'base64',
      ),
    })
    expect(upload.ok()).toBe(true)
    asset = (await upload.json()).id
  }
  const item = await (
    await page.request.post('/api/library', {
      data: {
        kind: 'prop',
        name: '版本同步水杯',
        description: '最初设定',
        projectId: canvas.projectId,
        images: asset ? [{ slot: 'main', assetId: asset }] : [],
      },
    })
  ).json()
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  const card = panel.getByRole('listitem').filter({ hasText: item.name })
  await card.hover()
  await card.getByRole('button', { name: '添加到画布', exact: true }).click()
  await expect(panel).toBeHidden()
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  await card.getByRole('button').first().click()
  if (options.rename)
    await panel.getByRole('textbox', { name: '名称', exact: true }).fill('新版水杯名称')
  await panel.getByRole('textbox', { name: /^设定/ }).fill('新版设定')
  await panel.getByRole('button', { name: '保存', exact: true }).click()
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeDisabled()
  const updates = panel.getByRole('region', { name: '跨画布资产更新', exact: true })
  await updates.getByRole('button', { name: '查看画布中的版本', exact: true }).click()
  const sync = updates.getByRole('button', { name: '同步选中的字段', exact: true })
  await expect(updates.getByRole('checkbox', { name: '设定', exact: true })).toBeChecked()
  await expect(sync).toBeEnabled()
  const current = () =>
    page.evaluate(
      (id) => [...window.__plein.engine.doc.elements()].find((el) => el.params?.libraryId === id),
      item.id,
    )
  return { panel, updates, sync, item, canvas, current, asset }
}

test('读取差异刷新期间和失败后不允许提交旧快照，重试后实际同步正确字段', async ({ page }) => {
  const { updates, sync, item, current } = await fixture(page)
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let failed = true
  let afterWrite = false
  let finishRead!: () => void
  const readHeld = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  let readingAfterWrite = false
  await page.route(`**/api/library/${item.id}/updates`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await held
    if (afterWrite) {
      readingAfterWrite = true
      await readHeld
    }
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '差异暂不可读取' },
      })
    await route.continue()
  })
  await updates.getByRole('button', { name: '刷新差异', exact: true }).click()
  try {
    await expect(updates.getByRole('status')).toContainText('正在读取差异')
    await expect(sync).toBeDisabled()
    await expect(updates.getByRole('checkbox', { name: '设定', exact: true })).toBeDisabled()
  } finally {
    resume()
  }
  await expect(updates.getByRole('alert')).toContainText('差异暂不可读取')
  await expect(sync).toBeDisabled()
  failed = false
  await updates.getByRole('button', { name: '刷新差异', exact: true }).click()
  await expect(sync).toBeEnabled()
  afterWrite = true
  await sync.click()
  try {
    await expect.poll(() => readingAfterWrite).toBe(true)
    await expect(sync).toBeDisabled()
    await expect(updates.getByRole('checkbox', { name: '设定', exact: true })).toBeDisabled()
  } finally {
    finishRead()
  }
  await expect.poll(async () => (await current())?.params?.description).toBe('新版设定')
  await expect(updates.getByRole('status').filter({ hasText: '已同步' })).toBeVisible()
})

test('选择字段只更新设定，固定与解除固定保留当前版本并可继续同步名称', async ({ page }) => {
  const { updates, sync, item, current } = await fixture(page, { rename: true })
  const name = updates.getByRole('checkbox', { name: '名称', exact: true })
  await name.uncheck()
  await sync.click()
  await expect.poll(async () => (await current())?.params?.description).toBe('新版设定')
  expect((await current())?.name).toBe(item.name)
  await expect(name).toBeEnabled()
  await updates.getByRole('button', { name: '固定当前版本', exact: true }).click()
  await expect(updates.getByRole('button', { name: '解除固定', exact: true })).toBeEnabled()
  await expect(name).toBeDisabled()
  await expect(sync).toBeDisabled()
  expect((await current())?.name).toBe(item.name)
  await updates.getByRole('button', { name: '解除固定', exact: true }).click()
  await expect(name).toBeEnabled()
  await expect(name).toBeChecked()
  await sync.click()
  await expect.poll(async () => (await current())?.name).toBe('新版水杯名称')
})

test('同步失败不改画布，差异刷新恢复后可重新提交并显示面板内反馈', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  const { updates, sync, item, current } = await fixture(page)
  let failed = true
  let writes = 0
  await page.route(`**/api/library/${item.id}/updates`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    writes++
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '同步暂不可用' },
      })
    await route.continue()
  })
  await sync.click()
  await expect(updates.getByRole('alert')).toContainText('同步暂不可用')
  await expect(updates.getByRole('alert')).toContainText('请刷新差异后重试')
  expect((await current())?.params?.description).toBe('最初设定')
  await expect(sync).toBeDisabled()
  await updates.screenshot({
    path: test.info().outputPath('library-sync-failure.png'),
    animations: 'disabled',
  })
  failed = false
  await updates.getByRole('button', { name: '刷新差异', exact: true }).click()
  await expect(sync).toBeEnabled()
  await sync.click()
  await expect.poll(async () => (await current())?.params?.description).toBe('新版设定')
  await expect(updates.getByRole('status').filter({ hasText: '已同步' })).toBeVisible()
  expect(writes).toBe(2)
})

test('同步等待时切换编辑目标，操作可完成但迟到结果不通知或改动新面板', async ({ page }) => {
  const { panel, updates, sync, item, canvas, current } = await fixture(page)
  await page.request.post('/api/library', {
    data: { kind: 'scene', name: '同步期间的新编辑目标', projectId: canvas.projectId },
  })
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let requested = false
  await page.route(`**/api/library/${item.id}/updates`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    requested = true
    await held
    await route.continue()
  })
  try {
    await sync.click()
    await expect.poll(() => requested).toBe(true)
    await panel.getByRole('button', { name: '场景', exact: true }).click()
    await panel.getByRole('button', { name: '本项目', exact: true }).click()
    await panel
      .getByRole('listitem')
      .filter({ hasText: '同步期间的新编辑目标' })
      .getByRole('button')
      .first()
      .click()
  } finally {
    resume()
  }
  await expect.poll(async () => (await current())?.params?.description).toBe('新版设定')
  await expect(panel.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(
    '同步期间的新编辑目标',
  )
  await expect(panel.getByRole('status').filter({ hasText: '已同步' })).toHaveCount(0)
  await expect(page.locator('.ui-toast').filter({ hasText: '已同步' })).toHaveCount(0)
  await expect(
    updates.getByRole('button', { name: '查看画布中的版本', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false')
})

test('窄屏长画布名称与差异展开不撑出面板，选择字段和同步仍可操作', async ({ page }) => {
  const { updates, sync, canvas, current } = await fixture(page, { rename: true })
  const title = 'Canvas'.repeat(33)
  expect((await page.request.patch(`/api/canvases/${canvas.id}`, { data: { title } })).ok()).toBe(
    true,
  )
  await page.setViewportSize({ width: 320, height: 700 })
  await updates.getByRole('button', { name: '刷新差异', exact: true }).click()
  await expect(updates.getByText(`${title} · 版本同步水杯`, { exact: true })).toBeVisible()
  await updates.locator('summary').filter({ hasText: '设定' }).click()
  await expect(updates.getByText('最初设定', { exact: true })).toBeVisible()
  await expect(updates.getByText('新版设定', { exact: true })).toBeVisible()
  const layout = await updates.evaluate((el) => ({
    width: el.clientWidth,
    content: el.scrollWidth,
  }))
  expect(layout.content).toBeLessThanOrEqual(layout.width)
  const name = updates.getByRole('checkbox', { name: '名称', exact: true })
  await name.uncheck()
  await sync.scrollIntoViewIfNeeded()
  await expect(sync).toBeInViewport({ ratio: 1 })
  await updates.screenshot({ path: test.info().outputPath('library-updates-320.png') })
  await sync.click()
  await expect.poll(async () => (await current())?.params?.description).toBe('新版设定')
  expect((await current())?.name).toBe('版本同步水杯')
})

test('资产同步与固定不混入本地撤销，重做和刷新后版本保持一致', async ({ page }) => {
  const { panel, updates, sync, current } = await fixture(page)
  const local = await page.evaluate(() => {
    const id = window.__plein.addNode({
      type: 'plein/text',
      name: '独立的本地操作',
      params: { text: '保留正文' },
      x: 1700,
      y: 400,
    })
    return id
  })
  await sync.click()
  await expect.poll(async () => (await current())?.params?.description).toBe('新版设定')
  await updates.getByRole('button', { name: '固定当前版本', exact: true }).click()
  await expect(updates.getByRole('button', { name: '解除固定', exact: true })).toBeEnabled()
  const synced = await current()
  expect(synced?.params?.libraryPinned).toBe(true)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(panel).toBeHidden()
  await page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() => page.evaluate((id) => !!window.__plein.engine.doc.get(id), local))
    .toBe(false)
  expect(await current()).toEqual(synced)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect
    .poll(() => page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, local))
    .toBe('保留正文')
  expect(await current()).toEqual(synced)
  await page.reload()
  await waitEngine(page)
  await expect.poll(current).toEqual(synced)
  expect(await page.evaluate((id) => window.__plein.engine.doc.get(id)?.params?.text, local)).toBe(
    '保留正文',
  )
  await page.getByRole('button', { name: '资产库', exact: true }).click()
  await panel.getByRole('button', { name: '道具', exact: true }).click()
  await panel
    .locator(`[data-library-id="${synced!.params!.libraryId}"]`)
    .getByRole('button')
    .first()
    .click()
  await updates.getByRole('button', { name: '查看画布中的版本', exact: true }).click()
  await expect(updates.getByText('与资产库一致', { exact: true })).toBeVisible()
  await expect(updates.getByRole('button', { name: '解除固定', exact: true })).toBeEnabled()
  await expect(updates.getByRole('button', { name: '同步选中的字段', exact: true })).toBeDisabled()
})
