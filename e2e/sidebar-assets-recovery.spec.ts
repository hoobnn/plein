import { expect, test } from './fixtures'
import { contextMenu, newProject } from './canvas'

test('资产侧栏读取失败可原地重试，恢复后放置、定位和删除状态正确', async ({ page }) => {
  let reading = false
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  await page.route('**/api/library', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    if (!reading)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '资产列表暂不可用' },
      })
    await held
    await route.continue()
  })
  await newProject(page)
  const canvasId = page.url().split('/').at(-1)!
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'prop',
      name: '恢复读取后的透明水杯',
      description: '透明玻璃水杯',
      projectId: canvas.projectId,
    },
  })
  expect(created.ok()).toBe(true)
  const item = await created.json()
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await sidebar.getByRole('tab', { name: '资产', exact: true }).click()
  await expect(sidebar.getByRole('alert')).toContainText('资产列表暂不可用')
  await expect(sidebar.getByText('本项目还没有资产', { exact: true })).toHaveCount(0)
  await sidebar.screenshot({
    path: test.info().outputPath('sidebar-assets-read-error.png'),
    animations: 'disabled',
  })
  reading = true
  await sidebar.getByRole('button', { name: '重新读取', exact: true }).click()
  try {
    await expect(sidebar.getByRole('status')).toContainText('正在读取资产库')
    await expect(sidebar.getByRole('button', { name: '重新读取', exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('本项目还没有资产', { exact: true })).toHaveCount(0)
  } finally {
    resume()
  }
  const row = sidebar.getByRole('button').filter({ hasText: item.name })
  await expect(row).toBeVisible()
  await expect(sidebar.getByText('共 1 项资产', { exact: true })).toBeVisible()
  await expect(sidebar.getByRole('alert')).toHaveCount(0)
  await row.click()
  const cards = () =>
    page.evaluate(
      (id) =>
        [...window.__plein.engine.doc.elements()]
          .filter((el) => el.params?.libraryId === id)
          .map((el) => el.id),
      item.id,
    )
  await expect.poll(cards).toHaveLength(1)
  const [id] = await cards()
  await expect(row).toContainText('已在画布')
  await row.click()
  expect(await cards()).toEqual([id])
  expect(await page.evaluate(() => window.__plein.engine.selection.values())).toEqual([id])
  await contextMenu(page, id!, '删除')
  await expect(row).not.toContainText('已在画布')
  await row.click()
  await expect.poll(cards).toHaveLength(1)
  expect((await cards())[0]).not.toBe(id)
})

test('首次读取未完成时显示进度，侧栏与弹窗共用读取，完成后才展示空状态', async ({ page }) => {
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let requests = 0
  await page.route('**/api/library', async (route) => {
    requests++
    await held
    await route.continue()
  })
  await newProject(page)
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await sidebar.getByRole('tab', { name: '资产', exact: true }).click()
  try {
    await expect(sidebar.getByRole('status')).toContainText('正在读取资产库')
    await expect(sidebar.getByText('本项目还没有资产', { exact: true })).toHaveCount(0)
    await sidebar.getByRole('button', { name: '打开资产库', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '资产库', exact: true })
    await panel.getByRole('button', { name: '本项目', exact: true }).click()
    await expect(panel.getByRole('status')).toContainText('正在读取资产库')
    expect(requests).toBe(1)
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
  } finally {
    resume()
  }
  await expect(sidebar.getByText('本项目还没有资产', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('共 0 项资产', { exact: true })).toBeVisible()
  await expect(sidebar.getByRole('status')).toHaveCount(0)
})

test('刷新失败保留已读资产并说明状态，重试期间不显示错误空列表', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 560 })
  await newProject(page)
  const canvasId = page.url().split('/').at(-1)!
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  const created = await page.request.post('/api/library', {
    data: {
      kind: 'character',
      name: '缓存中的角色',
      projectId: canvas.projectId,
    },
  })
  expect(created.ok()).toBe(true)
  const sidebar = page.getByRole('complementary', { name: '侧栏', exact: true })
  await sidebar.getByRole('tab', { name: '资产', exact: true }).click()
  await sidebar.getByRole('button', { name: '打开资产库', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '资产库', exact: true })
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  await expect(panel.getByText('缓存中的角色', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  const row = sidebar.getByRole('button', { name: '缓存中的角色', exact: true })
  await expect(row).toBeVisible()
  let failed = true
  let resume!: () => void
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  await page.route('**/api/library', async (route) => {
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: 'test_failure', message: '刷新暂不可用，请稍后重新读取' },
      })
    await held
    await route.continue()
  })
  await sidebar.getByRole('button', { name: '打开资产库', exact: true }).click()
  await panel.getByRole('button', { name: '本项目', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('保留上次读取的结果')
  await expect(panel.getByText('缓存中的角色', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sidebar.getByRole('alert')).toContainText('刷新暂不可用')
  await expect(row).toBeVisible()
  await expect(sidebar.getByText('共 1 项资产', { exact: true })).toBeVisible()
  const resize = sidebar.getByRole('separator', { name: '调整侧栏宽度', exact: true })
  await resize.focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(resize).toHaveAttribute('aria-valuenow', '220')
  await sidebar.screenshot({
    path: test.info().outputPath('sidebar-assets-cached-error.png'),
    animations: 'disabled',
  })
  failed = false
  await sidebar.getByRole('button', { name: '重新读取', exact: true }).click()
  try {
    await expect(sidebar.getByRole('status')).toContainText('正在刷新资产库')
    await expect(row).toBeVisible()
    await expect(sidebar.getByText('本项目还没有资产', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByRole('alert')).toHaveCount(0)
  } finally {
    resume()
  }
  await expect(sidebar.getByRole('status')).toHaveCount(0)
  await expect(row).toBeVisible()
})
