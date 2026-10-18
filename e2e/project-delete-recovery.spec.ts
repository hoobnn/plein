import { expect, type Page, test } from '@playwright/test'
import { newProject } from './canvas'

const cached = (page: Page, id: string) =>
  page.evaluate(
    async (id) => (await indexedDB.databases()).some((db) => db.name === `plein-canvas:${id}`),
    id,
  )

async function fixture(page: Page) {
  await newProject(page)
  const canvasId = decodeURIComponent(page.url().split('#/c/')[1]!)
  const canvas = await (await page.request.get(`/api/canvases/${canvasId}`)).json()
  await expect.poll(() => cached(page, canvasId)).toBe(true)
  await page.goto('/')
  const card = page.locator(`[data-project="${canvas.projectId}"]`)
  await expect(card).toBeVisible()
  return { card, projectId: canvas.projectId as string, canvasId, homeUrl: page.url() }
}

async function confirmDelete(page: Page) {
  const dialog = page.getByRole('dialog', { name: /^删除项目/ })
  await expect(dialog).toContainText('素材文件和资产库')
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
}

test('删除项目失败在原卡片说明原因，项目仍可打开，返回后可重新确认删除', async ({ page }) => {
  const f = await fixture(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  let writes = 0
  await page.route(`**/api/projects/${f.projectId}`, (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    writes++
    if (writes === 1)
      return route.fulfill({ status: 503, json: { message: '项目删除暂时失败，请重试' } })
    return route.continue()
  })
  await f.card.getByRole('button', { name: '删除', exact: true }).click()
  await confirmDelete(page)
  await expect(f.card.getByRole('alert')).toContainText('项目删除暂时失败，请重试')
  await expect(f.card.getByRole('button', { name: '删除', exact: true })).toBeEnabled()
  expect((await page.request.get(`/api/projects/${f.projectId}`)).ok()).toBe(true)
  expect(await cached(page, f.canvasId)).toBe(true)
  await f.card.getByRole('link').last().click()
  await expect(page).toHaveURL(new RegExp(`#/c/${f.canvasId}$`))
  await page.goto('/')
  await f.card.getByRole('button', { name: '删除', exact: true }).click()
  await confirmDelete(page)
  await expect(f.card).toHaveCount(0)
  expect((await page.request.get(`/api/projects/${f.projectId}`)).status()).toBe(404)
  expect((await page.request.get(`/api/canvases/${f.canvasId}`)).status()).toBe(404)
  await expect.poll(() => cached(page, f.canvasId)).toBe(false)
  expect(writes).toBe(2)
  expect(errors).toEqual([])
})

test('删除前读取画布列表失败时保留项目并可重试，不跳过缓存清理所需的清单', async ({ page }) => {
  const f = await fixture(page)
  let lists = 0,
    writes = 0
  await page.route(`**/api/projects/${f.projectId}/canvases`, (route) => {
    lists++
    if (lists === 1) return route.fulfill({ status: 503, json: { message: '画布清单暂时不可用' } })
    return route.continue()
  })
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().endsWith(`/api/projects/${f.projectId}`))
      writes++
  })
  await f.card.getByRole('button', { name: '删除', exact: true }).click()
  await confirmDelete(page)
  await expect(f.card.getByRole('alert')).toContainText('画布清单暂时不可用')
  expect(writes).toBe(0)
  expect(await cached(page, f.canvasId)).toBe(true)
  expect((await page.request.get(`/api/projects/${f.projectId}`)).ok()).toBe(true)
  await f.card.getByRole('button', { name: '删除', exact: true }).click()
  await confirmDelete(page)
  await expect(f.card).toHaveCount(0)
  await expect.poll(() => cached(page, f.canvasId)).toBe(false)
  expect(writes).toBe(1)
  expect(lists).toBe(2)
})

test('删除等待中显示状态，卡片其他操作和打开入口不再发出竞争请求', async ({ page }) => {
  const f = await fixture(page)
  await page.setViewportSize({ width: 390, height: 700 })
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let writes = 0
  await page.route(`**/api/projects/${f.projectId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    writes++
    await pending
    await route.continue()
  })
  try {
    await f.card.getByRole('button', { name: '删除', exact: true }).click()
    await confirmDelete(page)
    await expect.poll(() => writes).toBe(1)
    const status = f.card.getByRole('status')
    await expect(status).toContainText('正在删除项目')
    await expect(status).toBeInViewport()
    for (const name of ['删除', '重命名', '导出项目包', '项目素材', '项目检查点'])
      await expect(f.card.getByRole('button', { name, exact: true })).toBeDisabled()
    const title = f.card.getByRole('link').last()
    await expect(title).toHaveAttribute('aria-disabled', 'true')
    await title.click({ force: true })
    await expect(page).toHaveURL(f.homeUrl)
    await f.card.screenshot({
      path: test.info().outputPath('project-delete-pending.png'),
      animations: 'disabled',
    })
    release()
    await expect(f.card).toHaveCount(0)
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test('取消删除或 Esc 关闭确认框均不读取清单、不删除，焦点回到原卡片', async ({ page }) => {
  const f = await fixture(page)
  const requests: string[] = []
  page.on('request', (request) => {
    if (
      request.url().endsWith(`/api/projects/${f.projectId}/canvases`) ||
      (request.method() === 'DELETE' && request.url().endsWith(`/api/projects/${f.projectId}`))
    )
      requests.push(request.url())
  })
  const remove = f.card.getByRole('button', { name: '删除', exact: true })
  for (const action of ['cancel', 'escape'] as const) {
    await remove.click()
    const dialog = page.getByRole('dialog', { name: /^删除项目/ })
    await expect(dialog).toBeVisible()
    if (action === 'cancel') await dialog.getByRole('button', { name: '取消', exact: true }).click()
    else await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(remove).toBeEnabled()
    await expect(remove).toBeFocused()
    await expect(f.card.getByRole('status')).toHaveCount(0)
  }
  expect(requests).toEqual([])
})
